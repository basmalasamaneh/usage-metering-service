import type { Pool } from 'pg';
import type { Clock } from '../domain/period';
import { type ConsumeInput, type ConsumeOutcome, consumeBatch } from './consume';

interface Job {
  input: ConsumeInput;
  resolve(o: ConsumeOutcome): void;
  reject(e: unknown): void;
}
interface AccountQueue {
  jobs: Job[];
  draining: boolean;
}

export interface CoordinatorStats {
  batches: number;
  requests: number;
  maxBatchSize: number;
  avgBatchSize: number;
  failedBatches: number;
  isolatedRetries: number;
}

/**
 * Per-account group commit.
 *
 * Correctness never depends on this class: the database row lock on the account is the single
 * source of truth (it also protects several service instances). What the coordinator adds is
 * efficiency for hot accounts:
 *   - at most ONE transaction per account is in flight in this process, so requests that would
 *     only queue on the row lock wait in memory instead of each pinning a pooled connection
 *     (which would starve every other account);
 *   - whatever queued up while a transaction ran is decided together in the next one
 *     (up to `batchMax`), amortising round trips and the commit.
 * There is no artificial delay: with no contention a batch has exactly one request.
 */
export class ConsumeCoordinator {
  private readonly queues = new Map<string, AccountQueue>();
  private batches = 0;
  private requests = 0;
  private maxBatchSize = 0;
  private failedBatches = 0;
  private isolatedRetries = 0;

  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly batchMax: number,
  ) {}

  submit(accountId: string, input: ConsumeInput): Promise<ConsumeOutcome> {
    return new Promise<ConsumeOutcome>((resolve, reject) => {
      let q = this.queues.get(accountId);
      if (!q) {
        q = { jobs: [], draining: false };
        this.queues.set(accountId, q);
      }
      q.jobs.push({ input, resolve, reject });
      if (!q.draining) {
        q.draining = true;
        void this.drain(accountId, q);
      }
    });
  }

  stats(): CoordinatorStats {
    return {
      batches: this.batches,
      requests: this.requests,
      maxBatchSize: this.maxBatchSize,
      avgBatchSize: this.batches ? Number((this.requests / this.batches).toFixed(2)) : 0,
      failedBatches: this.failedBatches,
      isolatedRetries: this.isolatedRetries,
    };
  }

  private async drain(accountId: string, q: AccountQueue): Promise<void> {
    try {
      while (q.jobs.length > 0) {
        const batch = q.jobs.splice(0, this.batchMax);
        await this.runBatch(accountId, batch);
      }
    } finally {
      // No await between the loop condition and here, so no job can be enqueued in between.
      q.draining = false;
      if (q.jobs.length === 0) this.queues.delete(accountId);
    }
  }

  private async runBatch(accountId: string, batch: Job[]): Promise<void> {
    try {
      const outcomes = await consumeBatch(this.pool, this.clock, accountId, batch.map((j) => j.input));
      this.record(batch.length);
      batch.forEach((j, i) => j.resolve(outcomes[i] as ConsumeOutcome));
    } catch (err) {
      this.failedBatches++;
      if (batch.length === 1) {
        (batch[0] as Job).reject(err);
        return;
      }
      // The failed transaction rolled back completely, so nothing was counted. Retry the requests one by one
      // so a single bad request (or a transient error) cannot fail its neighbours.
      for (const job of batch) {
        this.isolatedRetries++;
        try {
          const [outcome] = await consumeBatch(this.pool, this.clock, accountId, [job.input]);
          this.record(1);
          job.resolve(outcome as ConsumeOutcome);
        } catch (e) {
          job.reject(e);
        }
      }
    }
  }

  private record(size: number): void {
    this.batches++;
    this.requests += size;
    if (size > this.maxBatchSize) this.maxBatchSize = size;
  }
}
