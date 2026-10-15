import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, assertInvariants, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
let acctPlan: string;
beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
  acctPlan = await c.makePlan('account', 'Team', 1000, 100);
  await c.put('/v1/account/plan', { planId: acctPlan });
});
afterAll(async () => {
  await assertInvariants(env, c.accountId);
  await env.close();
});

describe('changing plans', () => {
  it('a plan update applies to the very next request, without redeploying', async () => {
    const p = await c.makePlan('user', 'Light', 100, 10);
    await c.makeUser('u1', p);
    expect((await c.consume('u1', 15, 'a1')).body.reason).toMatchObject({ rule: 'max_units_per_request', limit: 10 });
    await c.patch(`/v1/plans/${p}`, { maxUnitsPerRequest: 20 });
    expect((await c.consume('u1', 15, 'a2')).body.accepted).toBe(true);
  });
  it('updating a shared plan affects every user assigned to it, each keeping separate usage', async () => {
    const p = await c.makePlan('user', 'Shared', 100, 10);
    await c.makeUser('s1', p);
    await c.makeUser('s2', p);
    await c.consume('s1', 10, 's1-a');
    await c.patch(`/v1/plans/${p}`, { maxUnitsPerRequest: 50 });
    expect((await c.consume('s1', 40, 's1-b')).body.accepted).toBe(true);
    expect((await c.consume('s2', 40, 's2-b')).body.accepted).toBe(true);
    expect((await c.get('/v1/users/s1/usage')).body.user.consumed).toBe(50);
    expect((await c.get('/v1/users/s2/usage')).body.user.consumed).toBe(40);
  });
  it('switching a user to another plan preserves consumed units (no fresh allowance)', async () => {
    const small = await c.makePlan('user', 'Small', 30, 30);
    const big = await c.makePlan('user', 'Big', 100, 100);
    await c.makeUser('sw', small);
    expect((await c.consume('sw', 30, 'sw-1')).body.accepted).toBe(true);
    expect((await c.consume('sw', 1, 'sw-2')).body.accepted).toBe(false);
    await c.put('/v1/users/sw/plan', { planId: big });
    const u = (await c.get('/v1/users/sw/usage')).body.user;
    expect(u).toMatchObject({ consumed: 30, remaining: 70 }); // 100 - 30, not 100
    expect((await c.consume('sw', 70, 'sw-3')).body.accepted).toBe(true);
    expect((await c.consume('sw', 1, 'sw-4')).body.accepted).toBe(false);
  });
  it('lowering an allowance below existing usage: remaining reads 0 and further requests are rejected at that level', async () => {
    const p = await c.makePlan('user', 'Shrinking', 100, 100);
    await c.makeUser('sh', p);
    await c.consume('sh', 60, 'sh-1');
    await c.patch(`/v1/plans/${p}`, { monthlyAllowance: 40 }); // below the 60 already used
    const u = (await c.get('/v1/users/sh/usage')).body;
    expect(u.user).toMatchObject({ consumed: 60, remaining: 0 });
    expect(u.maxAcceptableUnits).toBe(0);
    const r = await c.consume('sh', 1, 'sh-2');
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatchObject({ level: 'user', rule: 'monthly_allowance', remaining: 0, limit: 40 });
    // allowance becomes available again once it is raised above usage
    await c.patch(`/v1/plans/${p}`, { monthlyAllowance: 75 });
    expect((await c.get('/v1/users/sh/usage')).body.user.remaining).toBe(15);
    expect((await c.consume('sh', 15, 'sh-3')).body.accepted).toBe(true);
    expect((await c.consume('sh', 1, 'sh-4')).body.accepted).toBe(false);
  });
  it('the same holds for the account level (plan switched, usage kept)', async () => {
    const x = await env.newAccount('acct-level');
    const small = await x.makePlan('account', 'S', 20, 20);
    const large = await x.makePlan('account', 'L', 100, 100);
    await x.put('/v1/account/plan', { planId: small });
    await x.makeUser('u', await x.makePlan('user', 'U', null, null));
    await x.consume('u', 20, 'a1');
    expect((await x.consume('u', 1, 'a2')).body.reason).toMatchObject({ level: 'account', rule: 'monthly_allowance' });
    await x.put('/v1/account/plan', { planId: large });
    expect((await x.get('/v1/usage')).body.account).toMatchObject({ consumed: 20, remaining: 80 });
    expect((await x.consume('u', 80, 'a3')).body.accepted).toBe(true);
    await x.patch(`/v1/plans/${large}`, { monthlyAllowance: 10 });
    expect((await x.get('/v1/usage')).body.account).toMatchObject({ consumed: 100, remaining: 0 });
    await assertInvariants(env, x.accountId);
  });
  it('past request history is preserved unchanged, including the limits in force at the time', async () => {
    const p = await c.makePlan('user', 'History', 100, 10);
    await c.makeUser('hist', p);
    await c.consume('hist', 5, 'h-1');
    await c.consume('hist', 50, 'h-2'); // rejected at the time (limit 10)
    const before = (await c.get('/v1/requests/h-2')).body;
    await c.patch(`/v1/plans/${p}`, { name: 'History v2', maxUnitsPerRequest: 500, monthlyAllowance: 1 });
    await c.put('/v1/users/hist/plan', { planId: 'premium' });
    const after = (await c.get('/v1/requests/h-2')).body;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ accepted: false, user: { planName: 'History', maxUnitsPerRequest: 10 } });
    expect((await c.get('/v1/requests?userId=hist')).body.data).toHaveLength(2);
  });
});
