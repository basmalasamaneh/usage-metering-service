import type { Pool } from 'pg';
import { type PlanRow } from './plans';

export interface AccountRow {
  id: string;
  name: string;
  api_key_prefix: string;
  created_at: Date;
  plan: PlanRow;
}

const SELECT_ACCOUNT = `
  SELECT a.id, a.name, a.api_key_prefix, a.created_at,
         to_jsonb(p.*) AS plan
    FROM accounts a JOIN plans p ON p.id = a.plan_id`;

function map(r: Omit<AccountRow, 'plan'> & { plan: Record<string, unknown> }): AccountRow {
  const p = r.plan as unknown as PlanRow & { created_at: string; updated_at: string };
  return { ...r, plan: { ...p, created_at: new Date(p.created_at), updated_at: new Date(p.updated_at) } };
}

export async function insertAccount(
  pool: Pool,
  a: { name: string; planId: string; keyHash: Buffer; keyPrefix: string },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (name, plan_id, api_key_hash, api_key_prefix) VALUES ($1, $2, $3, $4) RETURNING id`,
    [a.name.trim(), a.planId, a.keyHash, a.keyPrefix],
  );
  return (rows[0] as { id: string }).id;
}

export async function findAccountIdByKeyHash(pool: Pool, keyHash: Buffer): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE api_key_hash = $1', [keyHash]);
  return rows[0]?.id ?? null;
}

export async function getAccount(pool: Pool, id: string): Promise<AccountRow | null> {
  const { rows } = await pool.query(`${SELECT_ACCOUNT} WHERE a.id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function setAccountPlan(pool: Pool, id: string, planId: string): Promise<void> {
  await pool.query('UPDATE accounts SET plan_id = $2 WHERE id = $1', [id, planId]);
}
