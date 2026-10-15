import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ConsumeCoordinator } from '../src/accounting/coordinator';
import { buildApp } from '../src/app';
import { createPool } from '../src/db/pool';
import { type Client, type TestEnv, assertInvariants, createEnv } from './helpers';

// The same guarantees must hold with batching disabled (1) and enabled (64).
describe.each([1, 64])('concurrency (BATCH_MAX=%i)', (batchMax) => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createEnv({ batchMax });
  });
  afterAll(() => env.close());

  async function setup(name: string, acctAllowance: number | null, acctPerReq: number | null, userAllowance: number | null, users: string[]) {
    const c = await env.newAccount(name);
    await c.put('/v1/account/plan', { planId: await c.makePlan('account', 'A', acctAllowance, acctPerReq) });
    const up = await c.makePlan('user', 'U', userAllowance, null);
    for (const u of users) await c.makeUser(u, up);
    return c;
  }

  it('never exceeds the shared account allowance (200 parallel requests, 100 available)', async () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}`);
    const c = await setup('shared', 100, null, null, users);
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => c.consume(users[i % 10] as string, 1, `r${i}`)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(res.filter((r) => r.body.accepted)).toHaveLength(100);
    const rejected = res.filter((r) => !r.body.accepted);
    expect(rejected).toHaveLength(100);
    expect(rejected.every((r) => r.body.reason.level === 'account' && r.body.reason.rule === 'monthly_allowance')).toBe(true);
    expect((await c.get('/v1/usage')).body.account).toMatchObject({ consumed: 100, remaining: 0 });
    expect((await assertInvariants(env, c.accountId)).accepted).toBe(100);
  });

  it("never exceeds one user's allowance while other users of the account keep going", async () => {
    const c = await setup('per-user', null, null, 30, ['x', 'y']);
    const res = await Promise.all(
      Array.from({ length: 120 }, (_, i) => c.consume(i % 2 ? 'x' : 'y', 1, `r${i}`)),
    );
    const acceptedBy = (u: string) => res.filter((r) => r.body.userId === u && r.body.accepted).length;
    expect(acceptedBy('x')).toBe(30);
    expect(acceptedBy('y')).toBe(30);
    await assertInvariants(env, c.accountId);
  });

  it('mixed sizes: totals are exact and every rejection was justified at the time it was decided', async () => {
    const c = await setup('mixed', 500, null, null, ['a', 'b', 'c']);
    const sizes = Array.from({ length: 300 }, (_, i) => (i % 7) + 1);
    const res = await Promise.all(sizes.map((u, i) => c.consume(['a', 'b', 'c'][i % 3] as string, u, `m${i}`)));
    const acceptedUnits = res.filter((r) => r.body.accepted).reduce((s, r) => s + r.body.units, 0);
    expect(acceptedUnits).toBeLessThanOrEqual(500);
    for (const r of res.filter((r) => !r.body.accepted)) {
      expect(r.body.reason.remaining).toBeLessThan(r.body.units); // really did not fit
    }
    // the account is "full" when nothing smaller than the smallest request fits any more
    expect((await c.get('/v1/usage')).body.account.consumed).toBe(acceptedUnits);
    await assertInvariants(env, c.accountId);
  });

  it('independent accounts do not interfere with each other', async () => {
    const accounts = await Promise.all(['p', 'q', 'r', 's'].map((n) => setup(`iso-${n}`, 50, null, null, ['u'])));
    const work = accounts.flatMap((c, ai) => Array.from({ length: 80 }, (_, i) => c.consume('u', 1, `a${ai}-${i}`)));
    await Promise.all(work);
    for (const c of accounts) {
      expect((await c.get('/v1/usage')).body.account.consumed).toBe(50);
      await assertInvariants(env, c.accountId);
    }
  });

  it('plan changes during load keep every decision consistent', async () => {
    const c = await setup('churn', 1000, null, null, ['u1', 'u2']);
    const planId = (await c.get('/v1/account')).body.plan.id;
    let stop = false;
    const churn = (async () => {
      let hi = false;
      while (!stop) {
        hi = !hi;
        await c.patch(`/v1/plans/${planId}`, { monthlyAllowance: hi ? 1000 : 50 });
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const res = await Promise.all(Array.from({ length: 300 }, (_, i) => c.consume(i % 2 ? 'u1' : 'u2', 1, `c${i}`)));
    stop = true;
    await churn;
    // every accepted decision's snapshot must be internally consistent with the limits it records
    for (const r of res.filter((r) => r.body.accepted)) {
      expect(r.body.account.consumed).toBeLessThanOrEqual(r.body.account.monthlyAllowance);
    }
    await assertInvariants(env, c.accountId);
  });
});

describe('several service instances sharing one database', () => {
  it('stay correct: the database lock, not the in-process queue, guarantees the allowance', async () => {
    const env = await createEnv();
    const extra = [1, 2].map(() => createPool(env.config));
    try {
      const apps = await Promise.all(extra.map((pool) => buildApp({ pool, config: env.config, clock: env.clock })));
      const c = await env.newAccount('multi');
      await c.put('/v1/account/plan', { planId: await c.makePlan('account', 'A', 150, null) });
      await c.makeUser('u', await c.makePlan('user', 'U', null, null));
      const clients = [c, ...apps.map((a) => ({ consume: (u: string, n: number, id: string) => a.inject({ method: 'POST', url: '/v1/consume', headers: { 'x-api-key': c.key! }, payload: { userId: u, units: n, requestId: id } }).then((r) => ({ body: r.json() })) }))];
      const res = await Promise.all(Array.from({ length: 300 }, (_, i) => (clients[i % 3] as Client).consume('u', 1, `mi-${i}`)));
      expect(res.filter((r) => r.body.accepted)).toHaveLength(150);
      await assertInvariants(env, c.accountId);
      await Promise.all(apps.map((a) => a.close()));
    } finally {
      await Promise.all(extra.map((p) => p.end()));
      await env.close();
    }
  });
});

describe('failure isolation inside a batch', () => {
  it('a failed batch rolls back completely and its requests are retried one by one', async () => {
    const env = await createEnv();
    try {
      const c = await env.newAccount();
      await c.makeUser('u');
      let calls = 0;
      const flaky = { connect: async () => { if (++calls === 2) throw new Error('simulated connection failure'); return env.pool.connect(); } } as unknown as Pool;
      const coord = new ConsumeCoordinator(flaky, env.clock, 64);
      const outs = await Promise.all([1, 2, 3, 4].map((i) => coord.submit(c.accountId, { userId: 'u', units: 1, requestId: `f${i}` })));
      expect(outs.every((o) => o.kind === 'decision' && o.decision.accepted)).toBe(true);
      expect(coord.stats().failedBatches).toBe(1);
      expect(coord.stats().isolatedRetries).toBe(3);
      expect((await c.get('/v1/users/u/usage')).body.user.consumed).toBe(4); // counted exactly once each
      await assertInvariants(env, c.accountId);
    } finally {
      await env.close();
    }
  });
  it('a request fails alone when the database keeps failing, and can be retried safely', async () => {
    const env = await createEnv();
    try {
      const c = await env.newAccount();
      await c.makeUser('u');
      const dead = { connect: async () => { throw new Error('db down'); } } as unknown as Pool;
      const coord = new ConsumeCoordinator(dead, env.clock, 64);
      await expect(coord.submit(c.accountId, { userId: 'u', units: 1, requestId: 'z' })).rejects.toThrow('db down');
      expect((await c.consume('u', 1, 'z')).body).toMatchObject({ accepted: true, replayed: false }); // nothing was recorded
    } finally {
      await env.close();
    }
  });
});
