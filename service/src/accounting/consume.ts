import type { Pool, PoolClient } from 'pg';
import { type Clock, periodOf } from '../domain/period';
import {
  type LevelSnapshot,
  type LevelState,
  type Violation,
  evaluate,
  snapshotOf,
} from '../domain/rules';

export interface ConsumeInput {
  userId: string; // the caller's own user identifier
  units: number;
  requestId: string;
}

export interface Decision {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  period: string; // 'YYYY-MM-01'
  reason: Violation | null;
  violations: Violation[];
  snapshot: { account: LevelSnapshot; user: LevelSnapshot };
  decidedAt: string;
}

export type ConsumeOutcome =
  | { kind: 'decision'; decision: Decision; replayed: boolean }
  | { kind: 'user_not_found' }
  | { kind: 'idempotency_conflict'; existing: { userId: string; units: number } };

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

/**
 * The per-account mutex. Every consumption of an account takes this lock first, so the account
 * counter, every user counter of the account and the idempotency check are serialised.
 * FOR NO KEY UPDATE does not conflict with the KEY SHARE locks taken by foreign-key checks
 * (e.g. registering a user) so those are never blocked by consumption.
 */
const LOCK_ACCOUNT_SQL = `BEGIN; SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE`;

/**
 * Reads everything needed to decide, in ONE statement (one round trip). It runs after the lock was
 * granted, so it sees every committed change: counters, plan assignments, plan limits, requests.
 *
 * The lookups are written so that the planner has exactly one sensible plan whatever the table
 * statistics say: requests go through the single-column unique idem_key, users through a LATERAL
 * probe that supplies both columns of the unique (account_id, external_id) index. With the naive
 * `request_id = ANY($n)` form the planner was observed scanning an account's WHOLE history on every
 * transaction while statistics were missing (2.3 ms vs 0.08 ms per lookup, and growing with history).
 */
const CONTEXT_SQL = `
SELECT
  (SELECT jsonb_build_object(
            'plan_id', p.id, 'plan_name', p.name,
            'monthly_allowance', p.monthly_allowance, 'max_units_per_request', p.max_units_per_request,
            'consumed', COALESCE((SELECT au.consumed FROM account_usage au
                                   WHERE au.account_id = a.id AND au.period = $2::date), 0))
     FROM accounts a JOIN plans p ON p.id = a.plan_id
    WHERE a.id = $1) AS account,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'user_pk', u.id, 'user_id', u.external_id,
            'plan_id', p.id, 'plan_name', p.name,
            'monthly_allowance', p.monthly_allowance, 'max_units_per_request', p.max_units_per_request,
            'consumed', COALESCE(uu.consumed, 0)))
     FROM unnest($3::text[]) AS q(external_id)
     CROSS JOIN LATERAL (SELECT uu.id, uu.external_id, uu.plan_id FROM users uu
                          WHERE uu.account_id = $1 AND uu.external_id = q.external_id LIMIT 1) u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period = $2::date), '[]'::jsonb) AS users,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'request_id', r.request_id, 'user_id', u.external_id, 'units', r.units,
            'accepted', r.accepted, 'period', r.period, 'reason', r.reason,
            'violations', r.violations, 'snapshot', r.snapshot, 'decided_at', r.decided_at))
     FROM unnest($4::text[]) AS q(request_id)
     JOIN consume_requests r ON r.idem_key = $1::text || ':' || q.request_id
     JOIN users u ON u.id = r.user_id), '[]'::jsonb) AS existing
`;

/**
 * Persists every new decision and the counter increments in one statement:
 *   $1 account id  $2 period  $3 decisions (jsonb array)  $4 account delta
 *   $5 per-user deltas (jsonb array)  $6 decided_at  $7 number of decisions expected to be new
 *   $8 account allowance in force (NULL = unlimited), stored with the month's counter
 * Counters are upserted: the first accepted request of a month creates the rows.
 */
const WRITE_SQL = `
WITH req AS (
  INSERT INTO consume_requests
         (account_id, request_id, user_id, units, accepted, period, reason, violations, snapshot, decided_at)
  SELECT $1::uuid, r.request_id, r.user_pk, r.units, r.accepted, $2::date, r.reason, r.violations, r.snapshot, $6::timestamptz
    FROM jsonb_to_recordset($3::jsonb)
         AS r(seq int, request_id text, user_pk bigint, units bigint, accepted boolean,
              reason jsonb, violations jsonb, snapshot jsonb)
   ORDER BY r.seq
  ON CONFLICT (idem_key) DO NOTHING
  RETURNING 1
), acct AS (
  INSERT INTO account_usage (account_id, period, consumed, monthly_allowance)
  SELECT $1::uuid, $2::date, $4::bigint, $8::bigint WHERE $4::bigint > 0
  ON CONFLICT (account_id, period)
  DO UPDATE SET consumed = account_usage.consumed + EXCLUDED.consumed,
                monthly_allowance = EXCLUDED.monthly_allowance, updated_at = now()
  RETURNING 1
), usr AS (
  INSERT INTO user_usage (user_id, period, consumed, monthly_allowance)
  SELECT d.user_pk, $2::date, d.consumed, d.monthly_allowance
    FROM jsonb_to_recordset($5::jsonb) AS d(user_pk bigint, consumed bigint, monthly_allowance bigint)
  ON CONFLICT (user_id, period)
  DO UPDATE SET consumed = user_usage.consumed + EXCLUDED.consumed,
                monthly_allowance = EXCLUDED.monthly_allowance, updated_at = now()
  RETURNING 1
)
-- Safety net, evaluated BEFORE the COMMIT that follows: under the account lock every row must be new.
-- If not (cannot happen), the division by zero raises, the transaction aborts and nothing is committed or counted.
-- (The divisor depends on a runtime value on purpose: a constant 1/0 would be folded at plan time and always fail.)
SELECT 1 / (CASE WHEN (SELECT count(*) FROM req) = $7::int THEN 1 ELSE 0 END) AS ok
`;

// ---------------------------------------------------------------------------------------------
// Row shapes returned by CONTEXT_SQL
// ---------------------------------------------------------------------------------------------

interface LevelRow {
  plan_id: string;
  plan_name: string;
  monthly_allowance: number | null;
  max_units_per_request: number | null;
  consumed: number;
}
interface UserRow extends LevelRow {
  user_pk: number;
  user_id: string;
}
interface ExistingRow {
  request_id: string;
  user_id: string;
  units: number;
  accepted: boolean;
  period: string;
  reason: Violation | null;
  violations: Violation[];
  snapshot: { account: LevelSnapshot; user: LevelSnapshot };
  decided_at: string;
}

function toState(level: 'account' | 'user', r: LevelRow): LevelState {
  return {
    level,
    planId: r.plan_id,
    planName: r.plan_name,
    monthlyAllowance: r.monthly_allowance,
    maxUnitsPerRequest: r.max_units_per_request,
    consumed: r.consumed,
  };
}

function existingToDecision(e: ExistingRow): Decision {
  return {
    requestId: e.request_id,
    userId: e.user_id,
    units: e.units,
    accepted: e.accepted,
    period: e.period,
    reason: e.reason,
    violations: e.violations,
    snapshot: e.snapshot,
    decidedAt: new Date(e.decided_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Batch transaction
// ---------------------------------------------------------------------------------------------

/**
 * Decides a batch of consume requests that all belong to ONE account, in a single transaction.
 *
 *   BEGIN
 *   lock the account row            <- serialises all consumption of the account (any instance)
 *   read plans, counters, history   <- fresh snapshot, after the lock
 *   decide each request in order    <- pure rules, running totals kept in memory
 *   write decisions + counters      <- one statement
 *   COMMIT                          <- lock released
 *

 * A batch of one is the plain single-request case; batching only amortises the fixed costs
 * (round trips, commit) when many requests of the same account are waiting.
 * Returns one outcome per input, in the same order.
 */
export async function consumeBatch(
  pool: Pool,
  clock: Clock,
  accountId: string,
  inputs: ConsumeInput[],
): Promise<ConsumeOutcome[]> {
  const client = await pool.connect();
  let broken = false;
  try {
    try {
      return await decideAndPersist(client, clock, accountId, inputs);
    } catch (err) {
      try {
        await client.query('ROLLBACK'); // harmless when no transaction is open
      } catch {
        broken = true; // connection unusable: make the pool discard it
      }
      throw err;
    }
  } finally {
    client.release(broken ? true : undefined);
  }
}

/**
 * Round trips are the dominant fixed cost of a transaction, so the statements are fused:
 *   1. "BEGIN; lock"         (simple protocol, one round trip)
 *   2. context read          (must be a separate statement: it needs a snapshot taken AFTER the lock)
 *   3. "write; COMMIT"       (simple protocol, one round trip; values are escaped literals)
 * A batch without new decisions (pure replays / unknown users) ends with a plain COMMIT.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Substitutes $n placeholders with escaped literals (needed to send several statements in one round trip). */
function inline(client: PoolClient, sql: string, params: (string | number | null)[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const v = params[Number(n) - 1];
    if (v === null) return 'NULL';
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new Error(`parameter $${n} is not a safe integer`);
      return String(v);
    }
    if (typeof v !== 'string') throw new Error(`missing parameter $${n}`);
    return client.escapeLiteral(v);
  });
}

async function decideAndPersist(
  client: PoolClient,
  clock: Clock,
  accountId: string,
  inputs: ConsumeInput[],
): Promise<ConsumeOutcome[]> {
  if (!UUID_RE.test(accountId)) throw new Error('invalid account id'); // defensive: it is inlined into SQL below
  await client.query(inline(client, LOCK_ACCOUNT_SQL, [accountId]));

  const now = clock.now(); // "when it is processed" decides the UTC month
  const period = periodOf(now);
  const decidedAt = now.toISOString();

  const userIds = [...new Set(inputs.map((i) => i.userId))];
  const requestIds = [...new Set(inputs.map((i) => i.requestId))];
  const ctx = (await client.query(CONTEXT_SQL, [accountId, period, userIds, requestIds])).rows[0] as {
    account: LevelRow | null;
    users: UserRow[];
    existing: ExistingRow[];
  };
  if (!ctx.account) throw new Error(`account ${accountId} vanished`); // cannot happen: key resolved to it

  const account = toState('account', ctx.account);
  const users = new Map<string, { pk: number; state: LevelState }>(
    ctx.users.map((u) => [u.user_id, { pk: u.user_pk, state: toState('user', u) }]),
  );
  // Requests already decided, from earlier transactions or earlier in this batch.
  const known = new Map<string, Decision>(ctx.existing.map((e) => [e.request_id, existingToDecision(e)]));

  const outcomes: ConsumeOutcome[] = [];
  const rows: unknown[] = [];
  const userDeltas = new Map<number, { consumed: number; allowance: number | null }>();
  let accountDelta = 0;

  for (const input of inputs) {
    const prior = known.get(input.requestId);
    if (prior) {
      outcomes.push(
        prior.userId === input.userId && prior.units === input.units
          ? { kind: 'decision', decision: prior, replayed: true }
          : { kind: 'idempotency_conflict', existing: { userId: prior.userId, units: prior.units } },
      );
      continue;
    }

    const user = users.get(input.userId);
    if (!user) {
      outcomes.push({ kind: 'user_not_found' });
      continue;
    }

    const violations = evaluate(input.units, user.state, account);
    const accepted = violations.length === 0;
    if (accepted) {
      user.state.consumed += input.units;
      account.consumed += input.units;
      accountDelta += input.units;
      userDeltas.set(user.pk, {
        consumed: (userDeltas.get(user.pk)?.consumed ?? 0) + input.units,
        allowance: user.state.monthlyAllowance,
      });
    }

    const decision: Decision = {
      requestId: input.requestId,
      userId: input.userId,
      units: input.units,
      accepted,
      period,
      reason: violations[0] ?? null,
      violations,
      snapshot: { account: snapshotOf(account), user: snapshotOf(user.state) },
      decidedAt,
    };
    known.set(input.requestId, decision);
    outcomes.push({ kind: 'decision', decision, replayed: false });
    rows.push({
      seq: rows.length,
      request_id: decision.requestId,
      user_pk: user.pk,
      units: decision.units,
      accepted,
      reason: decision.reason,
      violations: decision.violations,
      snapshot: decision.snapshot,
    });
  }

  if (rows.length === 0) {
    await client.query('COMMIT');
  } else {
    const deltas = [...userDeltas].map(([user_pk, d]) => ({ user_pk, consumed: d.consumed, monthly_allowance: d.allowance }));
    await client.query(
      inline(client, `${WRITE_SQL}; COMMIT`, [
        accountId,
        period,
        JSON.stringify(rows),
        accountDelta,
        JSON.stringify(deltas),
        decidedAt,
        rows.length,
        account.monthlyAllowance,
      ]),
    );
  }
  return outcomes;
}
