import type { Decision } from '../accounting/consume';
import type { LevelState } from '../domain/rules';
import type { PlanRow } from '../repo/plans';
import type { LevelUsage } from '../repo/usage';

export function planView(p: PlanRow) {
  return {
    id: p.id,
    scope: p.scope,
    name: p.name,
    monthlyAllowance: p.monthly_allowance,
    maxUnitsPerRequest: p.max_units_per_request,
    predefined: p.account_id === null,
    readOnly: p.account_id === null,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}

export const toLevelState = (level: 'account' | 'user', u: LevelUsage): LevelState => ({
  level,
  planId: u.plan.id,
  planName: u.plan.name,
  monthlyAllowance: u.plan.monthly_allowance,
  maxUnitsPerRequest: u.plan.max_units_per_request,
  consumed: u.consumed,
});

/**
 * Consumed / remaining for one level and month.
 *  - Current month: the allowance of the plan currently assigned (`allowanceSource: current_plan`).
 *  - Closed month: the allowance recorded with that month's counter at its last accepted request
 *    (`recorded_at_last_request`), so a later plan change does not rewrite what that month looked like.
 *    A month with no counter row consumed nothing; it is reported against the current plan.
 * `remaining` is never negative (an allowance lowered below usage reads 0); null = unlimited.
 */
export function usageView(u: LevelUsage, isCurrentMonth: boolean) {
  const recorded = !isCurrentMonth && u.recorded !== null;
  const allowance = recorded ? (u.recorded as { allowance: number | null }).allowance : u.plan.monthly_allowance;
  return {
    plan: planView(u.plan),
    consumed: u.consumed,
    monthlyAllowance: allowance,
    remaining: allowance === null ? null : Math.max(0, allowance - u.consumed),
    allowanceSource: recorded ? ('recorded_at_last_request' as const) : ('current_plan' as const),
  };
}

export function decisionView(d: Decision, replayed: boolean) {
  return {
    requestId: d.requestId,
    userId: d.userId,
    units: d.units,
    accepted: d.accepted,
    month: d.period.slice(0, 7),
    reason: d.reason,
    violations: d.violations,
    account: d.snapshot.account,
    user: d.snapshot.user,
    decidedAt: d.decidedAt,
    replayed,
  };
}
