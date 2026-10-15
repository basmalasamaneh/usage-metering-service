import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, assertInvariants, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
let userPlan: string;
let accountPlan: string;
beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
  accountPlan = await c.makePlan('account', 'A', 100, 100);
  await c.put('/v1/account/plan', { planId: accountPlan });
  userPlan = await c.makePlan('user', 'U', 60, 60);
  await c.makeUser('u', userPlan);
});
afterAll(async () => {
  await assertInvariants(env, c.accountId);
  await env.close();
});

describe('UTC calendar months', () => {
  it('usage belongs to the month in which the request is processed; each month starts at zero', async () => {
    env.clock.set('2026-09-30T23:59:59.000Z');
    expect((await c.consume('u', 60, 'sep-1')).body).toMatchObject({ accepted: true, month: '2026-09' });
    expect((await c.consume('u', 1, 'sep-2')).body.accepted).toBe(false); // September exhausted

    env.clock.set('2026-10-01T00:00:00.000Z'); // one second later: new UTC month
    const fresh = (await c.get('/v1/users/u/usage')).body;
    expect(fresh).toMatchObject({ month: '2026-10', isCurrentMonth: true });
    expect(fresh.user).toMatchObject({ consumed: 0, remaining: 60 });
    expect(fresh.account).toMatchObject({ consumed: 0, remaining: 100 });
    expect((await c.consume('u', 25, 'oct-1')).body).toMatchObject({ accepted: true, month: '2026-10' });
  });
  it('previous months stay queryable', async () => {
    const sep = (await c.get('/v1/users/u/usage?month=2026-09')).body;
    expect(sep).toMatchObject({ month: '2026-09', isCurrentMonth: false, maxAcceptableUnits: null });
    expect(sep.user).toMatchObject({ consumed: 60, monthlyAllowance: 60, remaining: 0, allowanceSource: 'recorded_at_last_request' });
    expect(sep.account).toMatchObject({ consumed: 60, monthlyAllowance: 100, remaining: 40, allowanceSource: 'recorded_at_last_request' });
    const acct = (await c.get('/v1/usage?month=2026-09')).body;
    expect(acct.account.consumed).toBe(60);
    expect(acct.users.data[0]).toMatchObject({ userId: 'u', consumed: 60 });
    expect((await c.get('/v1/usage/months')).body.data).toEqual([
      { month: '2026-10', consumed: 25 },
      { month: '2026-09', consumed: 60 },
    ]);
    // a month in which nothing was consumed: zero usage, reported against the plan currently assigned
    expect((await c.get('/v1/usage?month=2025-01')).body.account).toMatchObject({ consumed: 0, remaining: 100, allowanceSource: 'current_plan' });
  });
  it('a closed month keeps the allowance it had, even after the plan is changed later', async () => {
    await c.patch(`/v1/plans/${userPlan}`, { monthlyAllowance: 1000 });
    await c.patch(`/v1/plans/${accountPlan}`, { monthlyAllowance: 5000 });
    const sep = (await c.get('/v1/users/u/usage?month=2026-09')).body;
    expect(sep.user).toMatchObject({ monthlyAllowance: 60, remaining: 0 }); // unchanged
    expect(sep.account).toMatchObject({ monthlyAllowance: 100, remaining: 40 });
    const oct = (await c.get('/v1/users/u/usage')).body; // current month follows the new plan immediately
    expect(oct.user).toMatchObject({ monthlyAllowance: 1000, remaining: 975, allowanceSource: 'current_plan' });
    expect(oct.account).toMatchObject({ monthlyAllowance: 5000, remaining: 4975 });
    await c.patch(`/v1/plans/${userPlan}`, { monthlyAllowance: 60 });
    await c.patch(`/v1/plans/${accountPlan}`, { monthlyAllowance: 100 });
  });
  it('a closed month of an unlimited plan reports remaining null', async () => {
    const x = await env.newAccount('unlimited-months');
    await x.put('/v1/account/plan', { planId: await x.makePlan('account', 'U', null, null) });
    await x.makeUser('u', await x.makePlan('user', 'U', null, null));
    env.clock.set('2026-03-10T00:00:00Z');
    await x.consume('u', 5, 'm1');
    env.clock.set('2026-10-15T12:00:00Z');
    const mar = (await x.get('/v1/users/u/usage?month=2026-03')).body;
    expect(mar.user).toMatchObject({ consumed: 5, monthlyAllowance: null, remaining: null });
  });
  it('request history can be filtered by month', async () => {
    expect((await c.get('/v1/requests?month=2026-09')).body.data.map((r: any) => r.requestId).sort()).toEqual(['sep-1', 'sep-2']);
    expect((await c.get('/v1/requests?month=2026-10')).body.data.map((r: any) => r.requestId)).toEqual(['oct-1']);
  });
  it('a request replayed in a later month returns the original decision and month', async () => {
    env.clock.set('2026-11-05T10:00:00Z');
    const r = await c.consume('u', 60, 'sep-1');
    expect(r.body).toMatchObject({ accepted: true, month: '2026-09', replayed: true });
    expect((await c.get('/v1/usage')).body.account.consumed).toBe(0); // November untouched
  });
  it('year rollover', async () => {
    env.clock.set('2026-12-31T23:59:59Z');
    await c.consume('u', 10, 'dec');
    env.clock.set('2027-01-01T00:00:00Z');
    await c.consume('u', 10, 'jan');
    const months = (await c.get('/v1/usage/months')).body.data.map((m: any) => m.month);
    expect(months).toContain('2026-12');
    expect(months).toContain('2027-01');
  });
  it('rejects malformed month parameters', async () => {
    expect((await c.get('/v1/usage?month=2026-13')).status).toBe(400);
    expect((await c.get('/v1/users/u/usage?month=oct')).status).toBe(400);
    expect((await c.get('/v1/requests?month=2026-1')).status).toBe(400);
  });
});
