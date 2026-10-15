import type { Pool } from 'pg';
import type { PlanRow } from './plans';

type RawPlan = PlanRow & { created_at: string; updated_at: string };
const plan = (p: RawPlan): PlanRow => ({ ...p, created_at: new Date(p.created_at), updated_at: new Date(p.updated_at) });

/** What the counter row of a month stores. null = no row: nothing was ever consumed in that month. */
export interface UsageRow {
  consumed: number;
  /** Allowance in force at the last accepted request of that month (null = unlimited). */
  allowance: number | null;
}

export interface LevelUsage {
  /** The plan currently assigned to the owner. */
  plan: PlanRow;
  consumed: number;
  /** The month's recorded counter row, if any (used to report "remaining" for closed months). */
  recorded: UsageRow | null;
}

const level = (rawPlan: RawPlan, row: UsageRow | null): LevelUsage => ({
  plan: plan(rawPlan),
  consumed: row?.consumed ?? 0,
  recorded: row,
});

/** One statement => one consistent snapshot of user + account state for a month. */
export async function getUserQuota(
  pool: Pool,
  accountId: string,
  userId: string,
  period: string,
): Promise<{ user: LevelUsage; account: LevelUsage } | null> {
  const { rows } = await pool.query(
    `SELECT to_jsonb(up.*) AS user_plan, to_jsonb(ap.*) AS account_plan,
            (SELECT jsonb_build_object('consumed', consumed, 'allowance', monthly_allowance)
               FROM user_usage WHERE user_id = u.id AND period = $3::date) AS user_row,
            (SELECT jsonb_build_object('consumed', consumed, 'allowance', monthly_allowance)
               FROM account_usage WHERE account_id = a.id AND period = $3::date) AS account_row
       FROM users u
       JOIN plans up ON up.id = u.plan_id
       JOIN accounts a ON a.id = u.account_id
       JOIN plans ap ON ap.id = a.plan_id
      WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, userId, period],
  );
  const r = rows[0];
  if (!r) return null;
  return { user: level(r.user_plan, r.user_row), account: level(r.account_plan, r.account_row) };
}

export async function getAccountUsage(pool: Pool, accountId: string, period: string): Promise<LevelUsage> {
  const { rows } = await pool.query(
    `SELECT to_jsonb(p.*) AS plan,
            (SELECT jsonb_build_object('consumed', consumed, 'allowance', monthly_allowance)
               FROM account_usage WHERE account_id = a.id AND period = $2::date) AS row
       FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.id = $1`,
    [accountId, period],
  );
  const r = rows[0];
  return level(r.plan, r.row);
}

export interface UserUsageRow extends LevelUsage {
  pk: number;
  userId: string;
}

/** Every registered user with their usage for the month (0 when none), paginated by registration order. */
export async function listUserUsage(
  pool: Pool,
  accountId: string,
  period: string,
  limit: number,
  afterPk: number | null,
): Promise<UserUsageRow[]> {
  const { rows } = await pool.query(
    `SELECT u.id AS pk, u.external_id AS user_id, to_jsonb(p.*) AS plan,
            CASE WHEN uu.user_id IS NULL THEN NULL
                 ELSE jsonb_build_object('consumed', uu.consumed, 'allowance', uu.monthly_allowance) END AS row
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period = $2::date
      WHERE u.account_id = $1 AND ($3::bigint IS NULL OR u.id > $3)
      ORDER BY u.id LIMIT $4`,
    [accountId, period, afterPk, limit],
  );
  return rows.map((r) => ({ pk: r.pk, userId: r.user_id, ...level(r.plan, r.row) }));
}

/** Months in which the account has consumed units, newest first. */
export async function listMonths(pool: Pool, accountId: string, limit: number): Promise<{ period: string; consumed: number }[]> {
  const { rows } = await pool.query<{ period: string; consumed: number }>(
    'SELECT period, consumed FROM account_usage WHERE account_id = $1 ORDER BY period DESC LIMIT $2',
    [accountId, limit],
  );
  return rows;
}
