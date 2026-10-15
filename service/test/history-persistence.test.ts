import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { Client, type TestEnv, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
  await c.put('/v1/account/plan', { planId: await c.makePlan('account', 'A', 1000, 100) });
  await c.makeUser('alice', await c.makePlan('user', 'U', 1000, 10));
  await c.makeUser('bob', await c.makePlan('user', 'U2', 1000, 10));
  for (let i = 1; i <= 7; i++) await c.consume(i % 2 ? 'alice' : 'bob', i === 4 ? 50 : 3, `h${i}`); // h4 is rejected
});
afterAll(() => env.close());

describe('request history', () => {
  it('is newest-first and paginates with a cursor', async () => {
    const p1 = (await c.get('/v1/requests?limit=3')).body;
    expect(p1.data.map((r: any) => r.requestId)).toEqual(['h7', 'h6', 'h5']);
    const p2 = (await c.get(`/v1/requests?limit=3&cursor=${p1.nextCursor}`)).body;
    expect(p2.data.map((r: any) => r.requestId)).toEqual(['h4', 'h3', 'h2']);
    const p3 = (await c.get(`/v1/requests?limit=3&cursor=${p2.nextCursor}`)).body;
    expect(p3.data.map((r: any) => r.requestId)).toEqual(['h1']);
    expect(p3.nextCursor).toBeNull();
  });
  it('filters by user and outcome', async () => {
    expect((await c.get('/v1/requests?userId=bob')).body.data.map((r: any) => r.requestId)).toEqual(['h6', 'h4', 'h2']);
    const rej = (await c.get('/v1/requests?outcome=rejected')).body.data;
    expect(rej.map((r: any) => r.requestId)).toEqual(['h4']);
    expect(rej[0].reason.rule).toBe('max_units_per_request');
    expect((await c.get('/v1/requests?outcome=accepted&userId=alice&limit=2')).body.data).toHaveLength(2);
    expect((await c.get('/v1/requests?userId=ghost')).status).toBe(404);
    expect((await c.get('/v1/requests?outcome=maybe')).status).toBe(400);
  });
  it('each entry shows the decision and the balances at that moment', async () => {
    const h5 = (await c.get('/v1/requests/h5')).body;
    expect(h5).toMatchObject({ accepted: true, userId: 'alice', units: 3, replayed: false });
    expect(h5.user.consumed).toBe(9); // h1 + h3 + h5
    expect(h5.account.consumed).toBe(12); // h1+h2+h3+h5, h4 was rejected
  });
  it('limit is bounded', async () => {
    expect((await c.get('/v1/requests?limit=0')).status).toBe(400);
    expect((await c.get('/v1/requests?limit=1000')).status).toBe(400);
  });
});

describe('persistence', () => {
  it('everything survives a restart (new pool, new app, same database)', async () => {
    const pool = createPool(env.config);
    const applied = await migrate(pool, env.config.migrationsDir);
    expect(applied).toEqual([]); // nothing to re-apply: migrations and seeds are idempotent
    const app = await buildApp({ pool, config: env.config, clock: env.clock });
    try {
      const again = new Client(app, c.key);
      expect((await again.get('/v1/account')).body.id).toBe(c.accountId); // same API key still works
      expect((await again.get('/v1/users')).body.data).toHaveLength(2);
      expect((await again.get('/v1/usage')).body.account.consumed).toBe(18);
      expect((await again.get('/v1/requests')).body.data).toHaveLength(7);
      expect((await again.consume('alice', 3, 'h1')).body).toMatchObject({ replayed: true }); // idempotency memory survives too
      expect((await again.get('/v1/plans')).body.data.filter((p: any) => p.predefined)).toHaveLength(4);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
