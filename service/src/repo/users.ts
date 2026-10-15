import type { Pool } from 'pg';
import { UNIQUE_VIOLATION, conflict, pgCode } from '../http/errors';
import type { PlanRow } from './plans';

export interface UserRow {
  pk: number;
  user_id: string; // external id
  created_at: Date;
  plan: PlanRow;
}

const SELECT_USER = `
  SELECT u.id AS pk, u.external_id AS user_id, u.created_at, to_jsonb(p.*) AS plan
    FROM users u JOIN plans p ON p.id = u.plan_id`;

function map(r: { pk: number; user_id: string; created_at: Date; plan: Record<string, unknown> }): UserRow {
  const p = r.plan as unknown as PlanRow & { created_at: string; updated_at: string };
  return { ...r, plan: { ...p, created_at: new Date(p.created_at), updated_at: new Date(p.updated_at) } };
}

export async function insertUser(pool: Pool, accountId: string, userId: string, planId: string): Promise<void> {
  try {
    await pool.query('INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3)', [accountId, userId, planId]);
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) throw conflict('user_exists', `User "${userId}" is already registered in this account.`);
    throw err;
  }
}

export async function getUser(pool: Pool, accountId: string, userId: string): Promise<UserRow | null> {
  const { rows } = await pool.query(`${SELECT_USER} WHERE u.account_id = $1 AND u.external_id = $2`, [accountId, userId]);
  return rows[0] ? map(rows[0]) : null;
}

/** Keyset pagination by internal id (registration order). */
export async function listUsers(pool: Pool, accountId: string, limit: number, afterPk: number | null): Promise<UserRow[]> {
  const { rows } = await pool.query(
    `${SELECT_USER} WHERE u.account_id = $1 AND ($2::bigint IS NULL OR u.id > $2) ORDER BY u.id LIMIT $3`,
    [accountId, afterPk, limit],
  );
  return rows.map(map);
}

export async function setUserPlan(pool: Pool, accountId: string, userId: string, planId: string): Promise<boolean> {
  const res = await pool.query('UPDATE users SET plan_id = $3 WHERE account_id = $1 AND external_id = $2', [accountId, userId, planId]);
  return res.rowCount === 1;
}
