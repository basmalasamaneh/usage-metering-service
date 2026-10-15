import type { Pool } from 'pg';
import type { Decision } from '../accounting/consume';
import type { Violation } from '../domain/rules';

interface Row {
  id: number;
  request_id: string;
  user_id: string;
  units: number;
  accepted: boolean;
  period: string;
  reason: Violation | null;
  violations: Violation[];
  snapshot: Decision['snapshot'];
  decided_at: Date;
}

export interface HistoryItem {
  seq: number;
  decision: Decision;
}

const toItem = (r: Row): HistoryItem => ({
  seq: r.id,
  decision: {
    requestId: r.request_id,
    userId: r.user_id,
    units: r.units,
    accepted: r.accepted,
    period: r.period,
    reason: r.reason,
    violations: r.violations,
    snapshot: r.snapshot,
    decidedAt: r.decided_at.toISOString(),
  },
});

const SELECT = `
  SELECT r.id, r.request_id, u.external_id AS user_id, r.units, r.accepted, r.period,
         r.reason, r.violations, r.snapshot, r.decided_at
    FROM consume_requests r JOIN users u ON u.id = r.user_id`;

export interface HistoryFilter {
  userPk?: number;
  period?: string;
  accepted?: boolean;
  beforeSeq?: number;
  limit: number;
}

/** Newest first, keyset pagination on the monotonically increasing sequence number. */
export async function listRequests(pool: Pool, accountId: string, f: HistoryFilter): Promise<HistoryItem[]> {
  const { rows } = await pool.query<Row>(
    `${SELECT}
      WHERE r.account_id = $1
        AND ($2::bigint IS NULL OR r.user_id = $2)
        AND ($3::date IS NULL OR r.period = $3)
        AND ($4::boolean IS NULL OR r.accepted = $4)
        AND ($5::bigint IS NULL OR r.id < $5)
      ORDER BY r.id DESC LIMIT $6`,
    [accountId, f.userPk ?? null, f.period ?? null, f.accepted ?? null, f.beforeSeq ?? null, f.limit],
  );
  return rows.map(toItem);
}

export async function getRequest(pool: Pool, accountId: string, requestId: string): Promise<HistoryItem | null> {
  const { rows } = await pool.query<Row>(`${SELECT} WHERE r.idem_key = $1::text || ':' || $2::text`, [accountId, requestId]);
  return rows[0] ? toItem(rows[0]) : null;
}
