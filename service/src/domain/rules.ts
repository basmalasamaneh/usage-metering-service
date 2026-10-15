/**
 * Quota rules. Pure functions only: no I/O, trivially unit-testable.
 *
 * A request is evaluated against BOTH levels (user plan and account plan). It is accepted only if
 * no rule at either level is violated. Adding a rule = add a column to `plans`, add an entry to
 * RULES (and to the plan views); the accounting code does not change.
 */

export type Level = 'account' | 'user';
export type RuleName = 'max_units_per_request' | 'monthly_allowance';

export interface PlanLimits {
  /** Units per UTC month; null = unlimited. */
  monthlyAllowance: number | null;
  /** Units per single request; null = unlimited. */
  maxUnitsPerRequest: number | null;
}

/** Everything the rules need to know about one level for one month. */
export interface LevelState extends PlanLimits {
  level: Level;
  planId: string;
  planName: string;
  consumed: number;
}

export interface Violation {
  level: Level;
  rule: RuleName;
  limit: number;
  requested: number;
  /** Only for monthly_allowance. */
  consumed?: number;
  remaining?: number;
  message: string;
}

export interface LevelSnapshot extends PlanLimits {
  planId: string;
  planName: string;
  consumed: number;
  remaining: number | null; // null = unlimited
}

interface Rule {
  name: RuleName;
  check(state: LevelState, units: number): Violation | null;
}

/** Remaining monthly units; never negative (an allowance lowered below usage reads as 0). null = unlimited. */
export function remainingMonthly(s: Pick<LevelState, 'monthlyAllowance' | 'consumed'>): number | null {
  return s.monthlyAllowance === null ? null : Math.max(0, s.monthlyAllowance - s.consumed);
}

const maxUnitsPerRequestRule: Rule = {
  name: 'max_units_per_request',
  check(s, units) {
    if (s.maxUnitsPerRequest === null || units <= s.maxUnitsPerRequest) return null;
    return {
      level: s.level,
      rule: 'max_units_per_request',
      limit: s.maxUnitsPerRequest,
      requested: units,
      message: `Requested ${units} units exceeds the ${s.level} plan "${s.planName}" limit of ${s.maxUnitsPerRequest} units per request.`,
    };
  },
};

const monthlyAllowanceRule: Rule = {
  name: 'monthly_allowance',
  check(s, units) {
    const remaining = remainingMonthly(s);
    if (remaining === null || s.monthlyAllowance === null || units <= remaining) return null;
    return {
      level: s.level,
      rule: 'monthly_allowance',
      limit: s.monthlyAllowance,
      requested: units,
      consumed: s.consumed,
      remaining,
      message: `Requested ${units} units but only ${remaining} remain in this month's allowance of the ${s.level} plan "${s.planName}".`,
    };
  },
};

/** Precedence: per-request limits are reported before monthly allowances (a request that is too big can never succeed). */
const RULES: Rule[] = [maxUnitsPerRequestRule, monthlyAllowanceRule];

/** All violations, ordered by precedence: rule order first, then user before account. Empty = accepted. */
export function evaluate(units: number, user: LevelState, account: LevelState): Violation[] {
  const out: Violation[] = [];
  for (const rule of RULES) {
    for (const level of [user, account]) {
      const v = rule.check(level, units);
      if (v) out.push(v);
    }
  }
  return out;
}

export function snapshotOf(s: LevelState): LevelSnapshot {
  return {
    planId: s.planId,
    planName: s.planName,
    monthlyAllowance: s.monthlyAllowance,
    maxUnitsPerRequest: s.maxUnitsPerRequest,
    consumed: s.consumed,
    remaining: remainingMonthly(s),
  };
}

/** The largest request that would be accepted right now (null = no limit at all). */
export function maxAcceptableUnits(levels: LevelState[]): number | null {
  const caps = levels
    .flatMap((l) => [l.maxUnitsPerRequest, remainingMonthly(l)])
    .filter((v): v is number => v !== null);
  return caps.length ? Math.min(...caps) : null;
}
