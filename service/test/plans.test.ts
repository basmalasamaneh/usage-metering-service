import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
});
afterAll(() => env.close());

describe('predefined plans', () => {
  it('are seeded on startup with the documented limits', async () => {
    const plans = (await c.get('/v1/plans')).body.data;
    const by = Object.fromEntries(plans.filter((p: any) => p.predefined).map((p: any) => [p.id, p]));
    expect(by.starter).toMatchObject({ scope: 'account', monthlyAllowance: 10000, maxUnitsPerRequest: 100, readOnly: true });
    expect(by.pro).toMatchObject({ scope: 'account', monthlyAllowance: 1000000, maxUnitsPerRequest: 1000 });
    expect(by.basic).toMatchObject({ scope: 'user', monthlyAllowance: 500, maxUnitsPerRequest: 20 });
    expect(by.premium).toMatchObject({ scope: 'user', monthlyAllowance: 5000, maxUnitsPerRequest: 200 });
  });
  it('are read-only', async () => {
    for (const id of ['starter', 'basic']) {
      const p = await c.patch(`/v1/plans/${id}`, { monthlyAllowance: 1 });
      expect(p.status).toBe(403);
      expect(p.body.error.code).toBe('plan_read_only');
      expect((await c.del(`/v1/plans/${id}`)).status).toBe(403);
    }
  });
  it('new accounts default to Starter, new users to Basic', async () => {
    expect((await c.get('/v1/account')).body.plan.id).toBe('starter');
    await c.makeUser('u');
    expect((await c.get('/v1/users/u')).body.plan.id).toBe('basic');
  });
  it('an account can start on another predefined account plan', async () => {
    const pro = await env.newAccount('pro-co', 'pro');
    expect((await pro.get('/v1/account')).body.plan.id).toBe('pro');
  });
});

describe('custom plans', () => {
  it('create / get / list / update / delete', async () => {
    const created = await c.post('/v1/plans', { scope: 'user', name: 'Team', monthlyAllowance: 100, maxUnitsPerRequest: 10 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Team', predefined: false, readOnly: false, monthlyAllowance: 100 });
    const id = created.body.id;
    expect((await c.get(`/v1/plans/${id}`)).body.name).toBe('Team');
    expect((await c.get('/v1/plans?scope=user')).body.data.map((p: any) => p.id)).toContain(id);
    expect((await c.get('/v1/plans?scope=account')).body.data.map((p: any) => p.id)).not.toContain(id);

    const upd = await c.patch(`/v1/plans/${id}`, { monthlyAllowance: 200, maxUnitsPerRequest: null });
    expect(upd.body).toMatchObject({ monthlyAllowance: 200, maxUnitsPerRequest: null, name: 'Team' });
    expect((await c.patch(`/v1/plans/${id}`, { name: 'Squad' })).body).toMatchObject({ name: 'Squad', monthlyAllowance: 200 });

    expect((await c.del(`/v1/plans/${id}`)).status).toBe(204);
    expect((await c.get(`/v1/plans/${id}`)).status).toBe(404);
  });
  it('omitted limits mean unlimited', async () => {
    const r = await c.post('/v1/plans', { scope: 'user', name: 'Unlimited' });
    expect(r.body).toMatchObject({ monthlyAllowance: null, maxUnitsPerRequest: null });
  });
  it('several users can share one plan', async () => {
    const id = await c.makePlan('user', 'shared', 100, 50);
    await c.makeUser('s1', id);
    await c.makeUser('s2', id);
    expect((await c.get('/v1/users/s1')).body.plan.id).toBe(id);
    expect((await c.get('/v1/users/s2')).body.plan.id).toBe(id);
  });
  it('rejects duplicate names within the same account and scope (case-insensitive)', async () => {
    await c.makePlan('account', 'Dup', 1, 1);
    const r = await c.post('/v1/plans', { scope: 'account', name: 'dup' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('plan_name_taken');
    expect((await c.post('/v1/plans', { scope: 'user', name: 'Dup' })).status).toBe(201); // other scope is fine
  });
  it('validates input', async () => {
    for (const body of [
      { scope: 'user', name: '' },
      { scope: 'team', name: 'x' },
      { scope: 'user', name: 'x', monthlyAllowance: -1 },
      { scope: 'user', name: 'x', monthlyAllowance: 1.5 },
      { scope: 'user', name: 'x', maxUnitsPerRequest: '5' },
      { scope: 'user', name: 'x', surprise: true },
    ]) {
      const r = await c.post('/v1/plans', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
    const id = await c.makePlan('user', 'v', 1, 1);
    expect((await c.patch(`/v1/plans/${id}`, {})).status).toBe(400);
  });
  it('cannot delete a plan that is still assigned', async () => {
    const id = await c.makePlan('user', 'inuse', 5, 5);
    await c.makeUser('holder', id);
    const r = await c.del(`/v1/plans/${id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('plan_in_use');
    await c.put('/v1/users/holder/plan', { planId: 'basic' });
    expect((await c.del(`/v1/plans/${id}`)).status).toBe(204);
  });
});

describe('assigning plans', () => {
  it('enforces scope: user plans for users, account plans for the account', async () => {
    await c.makeUser('scoped');
    const acctPlan = await c.makePlan('account', 'AP', 10, 10);
    const userPlan = await c.makePlan('user', 'UP', 10, 10);
    const r1 = await c.put('/v1/users/scoped/plan', { planId: acctPlan });
    expect([r1.status, r1.body.error.code]).toEqual([422, 'plan_scope_mismatch']);
    const r2 = await c.put('/v1/account/plan', { planId: userPlan });
    expect([r2.status, r2.body.error.code]).toEqual([422, 'plan_scope_mismatch']);
    expect((await c.put('/v1/users/scoped/plan', { planId: 'premium' })).body.plan.id).toBe('premium');
    expect((await c.put('/v1/account/plan', { planId: acctPlan })).body.plan.id).toBe(acctPlan);
  });
  it('unknown plan -> 404, unknown user -> 404', async () => {
    expect((await c.put('/v1/users/scoped/plan', { planId: 'nope' })).status).toBe(404);
    expect((await c.put('/v1/users/ghost/plan', { planId: 'basic' })).status).toBe(404);
  });
  it('user registration validation and duplicates', async () => {
    expect((await c.post('/v1/users', { userId: 'bad id with spaces' })).status).toBe(400);
    expect((await c.post('/v1/users', { userId: 'dupe' })).status).toBe(201);
    expect((await c.post('/v1/users', { userId: 'dupe' })).body.error.code).toBe('user_exists');
  });
  it('paginates users', async () => {
    const p = await env.newAccount('pager');
    for (let i = 1; i <= 5; i++) await p.makeUser(`u${i}`);
    const p1 = (await p.get('/v1/users?limit=2')).body;
    expect(p1.data.map((u: any) => u.userId)).toEqual(['u1', 'u2']);
    const p2 = (await p.get(`/v1/users?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.data.map((u: any) => u.userId)).toEqual(['u3', 'u4']);
    const p3 = (await p.get(`/v1/users?limit=2&cursor=${p2.nextCursor}`)).body;
    expect(p3.data.map((u: any) => u.userId)).toEqual(['u5']);
    expect(p3.nextCursor).toBeNull();
    expect((await p.get('/v1/users?cursor=@@@')).status).toBe(400);
  });
});
