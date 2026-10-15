import { describe, expect, it } from 'vitest';
import { evaluate, maxAcceptableUnits, remainingMonthly, type LevelState } from '../src/domain/rules';
import { periodFromMonth, periodOf } from '../src/domain/period';

const lvl = (level: 'user' | 'account', o: Partial<LevelState> = {}): LevelState => ({
  level, planId: 'p', planName: 'P', monthlyAllowance: 1000, maxUnitsPerRequest: 20, consumed: 0, ...o,
});

describe('rules (pure)', () => {
  it('accepts when both levels allow it', () => {
    expect(evaluate(10, lvl('user'), lvl('account'))).toEqual([]);
  });
  it('rejects by the user per-request limit first', () => {
    const v = evaluate(25, lvl('user'), lvl('account', { maxUnitsPerRequest: 100 }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ level: 'user', rule: 'max_units_per_request', limit: 20, requested: 25 });
  });
  it('rejects by the account monthly allowance when only 5 remain', () => {
    const v = evaluate(10, lvl('user'), lvl('account', { monthlyAllowance: 100, consumed: 95 }));
    expect(v[0]).toMatchObject({ level: 'account', rule: 'monthly_allowance', remaining: 5 });
  });
  it('reports every violation, per-request before monthly, user before account', () => {
    const v = evaluate(50, lvl('user', { monthlyAllowance: 10 }), lvl('account', { maxUnitsPerRequest: 30, monthlyAllowance: 10 }));
    expect(v.map((x) => `${x.level}:${x.rule}`)).toEqual([
      'user:max_units_per_request', 'account:max_units_per_request', 'user:monthly_allowance', 'account:monthly_allowance',
    ]);
  });
  it('allows exactly the remaining amount', () => {
    expect(evaluate(5, lvl('user'), lvl('account', { monthlyAllowance: 100, consumed: 95 }))).toEqual([]);
  });
  it('null means unlimited', () => {
    const u = lvl('user', { monthlyAllowance: null, maxUnitsPerRequest: null });
    expect(evaluate(1e9, u, { ...u, level: 'account' })).toEqual([]);
    expect(remainingMonthly(u)).toBeNull();
    expect(maxAcceptableUnits([u])).toBeNull();
  });
  it('remaining never goes negative when the allowance is lowered below usage', () => {
    expect(remainingMonthly({ monthlyAllowance: 50, consumed: 80 })).toBe(0);
    expect(evaluate(1, lvl('user'), lvl('account', { monthlyAllowance: 50, consumed: 80 }))[0]).toMatchObject({ rule: 'monthly_allowance', remaining: 0 });
  });
  it('zero allowance blocks everything', () => {
    expect(evaluate(1, lvl('user', { monthlyAllowance: 0 }), lvl('account'))).toHaveLength(1);
  });
  it('maxAcceptableUnits is the tightest cap', () => {
    expect(maxAcceptableUnits([lvl('user', { consumed: 995 }), lvl('account')])).toBe(5);
  });
});

describe('periods', () => {
  it('uses UTC calendar months', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-01');
    expect(periodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
    expect(periodOf(new Date('2026-12-31T23:30:00-05:00'))).toBe('2027-01-01'); // 04:30Z next year
  });
  it('parses YYYY-MM', () => {
    expect(periodFromMonth('2026-02')).toBe('2026-02-01');
    expect(periodFromMonth('2026-13')).toBeNull();
    expect(periodFromMonth('2026-2')).toBeNull();
  });
});
