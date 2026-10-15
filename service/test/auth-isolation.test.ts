import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, createEnv } from './helpers';

let env: TestEnv;
let a: Client;
let b: Client;
beforeAll(async () => {
  env = await createEnv();
  a = await env.newAccount('A');
  b = await env.newAccount('B');
});
afterAll(() => env.close());

describe('API key validation', () => {
  it('rejects a missing key', async () => {
    const r = await env.anonymous.get('/v1/account');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('missing_api_key');
  });
  it('rejects an invalid key on every protected endpoint', async () => {
    const bad = env.withKey('qk_not-a-real-key');
    for (const [m, url, body] of [
      ['GET', '/v1/account'], ['GET', '/v1/plans'], ['GET', '/v1/users'], ['GET', '/v1/usage'],
      ['GET', '/v1/requests'], ['POST', '/v1/users', { userId: 'x' }],
      ['POST', '/v1/consume', { userId: 'x', units: 1, requestId: 'r' }],
    ] as const) {
      const r = await bad.req(m, url, body);
      expect(r.status, `${m} ${url}`).toBe(401);
      expect(r.body.error.code).toBe('invalid_api_key');
    }
  });
  it('accepts the key it issued and identifies the account', async () => {
    const r = await a.get('/v1/account');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(a.accountId);
    expect(r.body.apiKeyPrefix).toBe(a.key!.slice(0, 10));
  });
  it('stores only a hash of the key', async () => {
    const { rows } = await env.pool.query('SELECT api_key_hash, api_key_prefix FROM accounts WHERE id = $1', [a.accountId]);
    expect(rows[0].api_key_hash.toString('utf8')).not.toContain(a.key);
    expect(rows[0].api_key_hash.length).toBe(32);
  });
  it('health is public; stats and account creation are open only when no ADMIN_TOKEN is configured', async () => {
    expect((await env.anonymous.get('/health')).status).toBe(200);
    expect((await env.anonymous.get('/stats')).status).toBe(200);
  });
  it('validates ids in the path', async () => {
    expect((await a.get('/v1/requests/' + 'x'.repeat(200))).status).toBe(400);
    // the longest valid id (128 chars) must work in a path
    const longId = 'u'.repeat(128);
    await a.makeUser(longId);
    expect((await a.get(`/v1/users/${longId}`)).status).toBe(200);
    expect((await a.get('/v1/requests/has%20space')).status).toBe(400);
  });
});

describe('admin token (optional guard for account creation)', () => {
  it('requires X-Admin-Token when configured', async () => {
    const guarded = await createEnv({ adminToken: 's3cret' });
    try {
      expect((await guarded.anonymous.post('/v1/accounts', { name: 'x' })).status).toBe(401);
      expect((await guarded.anonymous.post('/v1/accounts', { name: 'x' })).body.error.code).toBe('invalid_admin_token');
      const wrong = await guarded.app.inject({ method: 'POST', url: '/v1/accounts', headers: { 'x-admin-token': 'nope' }, payload: { name: 'x' } });
      expect(wrong.statusCode).toBe(401);
      const ok = await guarded.app.inject({ method: 'POST', url: '/v1/accounts', headers: { 'x-admin-token': 's3cret' }, payload: { name: 'x' } });
      expect(ok.statusCode).toBe(201);
      // operational stats are guarded by the same token
      expect((await guarded.anonymous.get('/stats')).status).toBe(401);
      expect((await guarded.app.inject({ method: 'GET', url: '/stats', headers: { 'x-admin-token': 's3cret' } })).statusCode).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});

describe('account isolation', () => {
  it('keeps users separate, even with the same user id', async () => {
    await a.makeUser('alice');
    await b.makeUser('alice'); // same external id in another account is fine
    await a.consume('alice', 10, 'r1');
    expect((await a.get('/v1/users/alice/usage')).body.user.consumed).toBe(10);
    expect((await b.get('/v1/users/alice/usage')).body.user.consumed).toBe(0);
  });
  it("a user of another account looks nonexistent (no existence leak)", async () => {
    await a.makeUser('only-in-a');
    expect((await b.get('/v1/users/only-in-a')).status).toBe(404);
    expect((await b.get('/v1/users/only-in-a/usage')).status).toBe(404);
    expect((await b.put('/v1/users/only-in-a/plan', { planId: 'premium' })).status).toBe(404);
    const r = await b.consume('only-in-a', 1, 'x1');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('user_not_found');
    // ...and nothing was counted for A.
    expect((await a.get('/v1/users/only-in-a/usage')).body.user.consumed).toBe(0);
  });
  it('lists only own users, usage, months and request history', async () => {
    await a.makeUser('a-only-2');
    const users = (await b.get('/v1/users')).body.data.map((u: { userId: string }) => u.userId);
    expect(users).not.toContain('a-only-2');
    const usage = (await b.get('/v1/usage')).body;
    expect(usage.account.consumed).toBe(0);
    const hist = (await b.get('/v1/requests')).body.data;
    expect(hist.every((r: { userId: string }) => r.userId === 'alice')).toBe(true);
    expect((await b.get('/v1/usage/months')).body.data).toEqual([]);
    expect((await b.get('/v1/requests/r1')).status).toBe(404); // A's request id
    expect((await a.get('/v1/requests/r1')).status).toBe(200);
  });
  it("cannot see, use, change or delete another account's custom plans", async () => {
    const planId = await a.makePlan('user', 'secret-plan', 5, 1);
    expect((await b.get(`/v1/plans/${planId}`)).status).toBe(404);
    expect((await b.get('/v1/plans')).body.data.map((p: { id: string }) => p.id)).not.toContain(planId);
    expect((await b.patch(`/v1/plans/${planId}`, { monthlyAllowance: 1e6 })).status).toBe(404);
    expect((await b.del(`/v1/plans/${planId}`)).status).toBe(404);
    await b.makeUser('bob');
    expect((await b.put('/v1/users/bob/plan', { planId })).status).toBe(404);
    expect((await b.post('/v1/users', { userId: 'carol', planId })).status).toBe(404);
  });
  it("one account's plan change never affects another account's decisions", async () => {
    const pa = await a.makePlan('user', 'shared-name', 1000, 5);
    const pb = await b.makePlan('user', 'shared-name', 1000, 500); // same name, different account
    await a.makeUser('u-plan', pa);
    await b.makeUser('u-plan', pb);
    expect((await a.consume('u-plan', 50, 'p1')).body.accepted).toBe(false);
    expect((await b.consume('u-plan', 50, 'p1')).body.accepted).toBe(true); // same request id, different account
  });
});
