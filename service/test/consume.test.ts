import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, assertInvariants, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
let n = 0;
const rid = () => `req-${++n}`;

beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
  // The example from the brief: account 10,000/month & 100/request; user 1,000/month & 20/request.
  const acct = await c.makePlan('account', 'Brief account', 10_000, 100);
  const user = await c.makePlan('user', 'Brief user', 1_000, 20);
  await c.put('/v1/account/plan', { planId: acct });
  await c.makeUser('alice', user);
  await c.makeUser('bob', user);
});
afterAll(async () => {
  await assertInvariants(env, c.accountId);
  await env.close();
});

describe('consume: how both plans apply', () => {
  it('rejects 25 units by the USER per-request limit although both monthly allowances suffice', async () => {
    const r = await c.consume('alice', 25, rid());
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatchObject({ level: 'user', rule: 'max_units_per_request', limit: 20, requested: 25 });
    expect(r.body.reason.message).toContain('per request');
  });
  it('a rejection consumes nothing', async () => {
    const u = (await c.get('/v1/users/alice/usage')).body;
    expect(u.user.consumed).toBe(0);
    expect(u.account.consumed).toBe(0);
  });
  it('accepts 10 units and counts them at both levels', async () => {
    const r = await c.consume('alice', 10, rid());
    expect(r.body).toMatchObject({ accepted: true, reason: null, violations: [], replayed: false, month: '2026-10' });
    expect(r.body.user).toMatchObject({ consumed: 10, remaining: 990 });
    expect(r.body.account).toMatchObject({ consumed: 10, remaining: 9990 });
  });
  it('account usage is the sum over its users; users sharing a plan do not share allowance', async () => {
    await c.consume('bob', 20, rid());
    const usage = (await c.get('/v1/usage')).body;
    expect(usage.account).toMatchObject({ consumed: 30, remaining: 9970 });
    const byUser = Object.fromEntries(usage.users.data.map((u: any) => [u.userId, u]));
    expect(byUser.alice).toMatchObject({ consumed: 10, remaining: 990 });
    expect(byUser.bob).toMatchObject({ consumed: 20, remaining: 980 });
    expect(byUser.alice.plan.id).toBe(byUser.bob.plan.id);
  });
  it('rejects by the ACCOUNT allowance when only 5 units remain, even though the user has plenty', async () => {
    const small = await env.newAccount('small');
    const ap = await small.makePlan('account', 'tiny', 15, 100);
    const up = await small.makePlan('user', 'big', 1000, 100);
    await small.put('/v1/account/plan', { planId: ap });
    await small.makeUser('u', up);
    expect((await small.consume('u', 10, 'a')).body.accepted).toBe(true); // 5 left
    const r = await small.consume('u', 10, 'b');
    expect(r.body.accepted).toBe(false);
    expect(r.body.reason).toMatchObject({ level: 'account', rule: 'monthly_allowance', remaining: 5, requested: 10 });
    expect(r.body.user.remaining).toBe(990);
    expect((await small.consume('u', 5, 'c')).body.accepted).toBe(true); // exactly the remainder
    expect((await small.get('/v1/usage')).body.account).toMatchObject({ consumed: 15, remaining: 0 });
    await assertInvariants(env, small.accountId);
  });
  it("a user with a bigger allowance does not raise the account's shared allowance", async () => {
    const x = await env.newAccount('cap');
    const ap = await x.makePlan('account', 'cap', 50, 50);
    const up = await x.makePlan('user', 'huge', 1_000_000, 1_000_000);
    await x.put('/v1/account/plan', { planId: ap });
    await x.makeUser('u', up);
    expect((await x.consume('u', 50, 'a')).body.accepted).toBe(true);
    expect((await x.consume('u', 1, 'b')).body.reason.level).toBe('account');
  });
  it('lists all violated rules but names one primary reason', async () => {
    const r = await c.consume('alice', 500, rid());
    expect(r.body.reason).toEqual(r.body.violations[0]);
    expect(r.body.violations.map((v: any) => `${v.level}:${v.rule}`)).toEqual(['user:max_units_per_request', 'account:max_units_per_request']);
  });
  it('explains the limits currently applied and the largest acceptable request', async () => {
    const r = (await c.get('/v1/users/alice/usage')).body;
    expect(r.user.plan).toMatchObject({ name: 'Brief user', monthlyAllowance: 1000, maxUnitsPerRequest: 20 });
    expect(r.account.plan).toMatchObject({ name: 'Brief account', monthlyAllowance: 10000, maxUnitsPerRequest: 100 });
    expect(r.maxAcceptableUnits).toBe(20);
  });
  it('unlimited plans never reject', async () => {
    const x = await env.newAccount('unl');
    const ap = await x.makePlan('account', 'unl', null, null);
    const up = await x.makePlan('user', 'unl', null, null);
    await x.put('/v1/account/plan', { planId: ap });
    await x.makeUser('u', up);
    expect((await x.consume('u', 999_999_999, 'big')).body.accepted).toBe(true);
    expect((await x.get('/v1/users/u/usage')).body.maxAcceptableUnits).toBeNull();
    expect((await x.get('/v1/users/u/usage')).body.user.remaining).toBeNull();
  });
});

describe('consume: input validation and errors', () => {
  it.each([
    ['zero', { userId: 'alice', units: 0, requestId: 'v1' }],
    ['negative', { userId: 'alice', units: -5, requestId: 'v2' }],
    ['fractional', { userId: 'alice', units: 1.5, requestId: 'v3' }],
    ['string number', { userId: 'alice', units: '5', requestId: 'v4' }],
    ['absurdly large', { userId: 'alice', units: 1e15, requestId: 'v5' }],
    ['missing requestId', { userId: 'alice', units: 5 }],
    ['missing userId', { units: 5, requestId: 'v6' }],
    ['empty requestId', { userId: 'alice', units: 5, requestId: '' }],
    ['unknown field', { userId: 'alice', units: 5, requestId: 'v7', extra: 1 }],
  ])('400 for %s', async (_name, body) => {
    const r = await c.post('/v1/consume', body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  });
  it('400 for malformed JSON, nothing is recorded', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/v1/consume', headers: { 'x-api-key': c.key!, 'content-type': 'application/json' }, payload: '{nope' });
    expect(res.statusCode).toBe(400);
  });
  it('404 for an unknown user, and it is not recorded in history', async () => {
    const r = await c.consume('ghost', 1, 'ghost-1');
    expect(r.status).toBe(404);
    expect((await c.get('/v1/requests/ghost-1')).status).toBe(404);
  });
  it('404 for an unknown endpoint', async () => {
    expect((await c.get('/v1/nope')).status).toBe(404);
  });
});
