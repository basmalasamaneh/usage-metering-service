import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FK_VIOLATION, UNIQUE_VIOLATION, conflict, pgCode } from '../http/errors';

export type Scope = 'account' | 'user';

export interface PlanRow {
  id: string;
  scope: Scope;
  account_id: string | null;
  name: string;
  monthly_allowance: number | null;
  max_units_per_request: number | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, scope, account_id, name, monthly_allowance, max_units_per_request, created_at, updated_at';

/** Plans an account may see and assign: predefined ones plus its own custom ones. */
export async function listPlans(pool: Pool, accountId: string, scope?: Scope): Promise<PlanRow[]> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT ${COLS} FROM plans
      WHERE (account_id IS NULL OR account_id = $1) AND ($2::text IS NULL OR scope = $2)
      ORDER BY (account_id IS NULL) DESC, scope, created_at, id`,
    [accountId, scope ?? null],
  );
  return rows;
}

export async function getVisiblePlan(pool: Pool, accountId: string, id: string): Promise<PlanRow | null> {
  const { rows } = await pool.query<PlanRow>(
    `SELECT ${COLS} FROM plans WHERE id = $1 AND (account_id IS NULL OR account_id = $2)`,
    [id, accountId],
  );
  return rows[0] ?? null;
}

/** A predefined (read-only, account-less) plan by id, or null. */
export async function getPredefinedPlan(pool: Pool, id: string): Promise<PlanRow | null> {
  const { rows } = await pool.query<PlanRow>(`SELECT ${COLS} FROM plans WHERE id = $1 AND account_id IS NULL`, [id]);
  return rows[0] ?? null;
}

export interface NewPlan {
  scope: Scope;
  name: string;
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

export async function createPlan(pool: Pool, accountId: string, p: NewPlan): Promise<PlanRow> {
  const id = `plan_${randomUUID().replace(/-/g, '')}`;
  try {
    const { rows } = await pool.query<PlanRow>(
      `INSERT INTO plans (id, scope, account_id, name, monthly_allowance, max_units_per_request)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [id, p.scope, accountId, p.name.trim(), p.monthlyAllowance, p.maxUnitsPerRequest],
    );
    return rows[0] as PlanRow;
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) throw conflict('plan_name_taken', `You already have a ${p.scope} plan named "${p.name}".`);
    throw err;
  }
}

export interface PlanPatch {
  name?: string;
  monthlyAllowance?: number | null;
  maxUnitsPerRequest?: number | null;
}

/** Updates a custom plan owned by the account. The change is visible to the very next consume request. */
export async function updatePlan(pool: Pool, accountId: string, id: string, patch: PlanPatch): Promise<PlanRow | null> {
  try {
    const { rows } = await pool.query<PlanRow>(
      `UPDATE plans SET
         name                  = CASE WHEN $3::boolean THEN $4 ELSE name END,
         monthly_allowance     = CASE WHEN $5::boolean THEN $6::bigint ELSE monthly_allowance END,
         max_units_per_request = CASE WHEN $7::boolean THEN $8::bigint ELSE max_units_per_request END,
         updated_at            = now()
       WHERE id = $1 AND account_id = $2
       RETURNING ${COLS}`,
      [
        id,
        accountId,
        patch.name !== undefined,
        patch.name?.trim() ?? null,
        patch.monthlyAllowance !== undefined,
        patch.monthlyAllowance ?? null,
        patch.maxUnitsPerRequest !== undefined,
        patch.maxUnitsPerRequest ?? null,
      ],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) throw conflict('plan_name_taken', `You already have a plan with that name.`);
    throw err;
  }
}

export async function deletePlan(pool: Pool, accountId: string, id: string): Promise<boolean> {
  try {
    const res = await pool.query('DELETE FROM plans WHERE id = $1 AND account_id = $2', [id, accountId]);
    return res.rowCount === 1;
  } catch (err) {
    if (pgCode(err) === FK_VIOLATION) throw conflict('plan_in_use', 'The plan is still assigned to the account or to users. Reassign them first.');
    throw err;
  }
}
