import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestEnv, assertInvariants, createEnv } from './helpers';

let env: TestEnv;
let c: Client;
beforeAll(async () => {
  env = await createEnv();
  c = await env.newAccount();
  await c.put('/v1/account/plan', { planId: await c.makePlan('account', 'A', 1000, 100) });
  await c.makeUser('u', await c.makePlan('user', 'U', 500, 50));
  await c.makeUser('v', 'basic');
});
afterAll(async () => {
  await assertInvariants(env, c.accountId);
  await env.close();
});

describe('retries with the same requestId', () => {
  it('an accepted request is counted once and returns the same decision', async () => {
    const first = await c.consume('u', 10, 'idem-1');
    const again = await c.consume('u', 10, 'idem-1');
    const third = await c.consume('u', 10, 'idem-1');
    expect(first.body.replayed).toBe(false);
    expect(again.body.replayed).toBe(true);
    expect({ ...again.body, replayed: false }).toEqual({ ...first.body, replayed: false });
    expect(third.status).toBe(200);
    expect((await c.get('/v1/users/u/usage')).body.user.consumed).toBe(10);
    expect((await c.get('/v1/requests?userId=u')).body.data).toHaveLength(1);
  });
  it('a rejected request replays as the same rejection', async () => {
    const first = await c.consume('u', 60, 'idem-2');
    const again = await c.consume('u', 60, 'idem-2');
    expect(first.body.accepted).toBe(false);
    expect(again.body).toMatchObject({ accepted: false, replayed: true, reason: first.body.reason });
  });
  it('a replay returns the ORIGINAL decision even after plans changed (the retry is not re-evaluated)', async () => {
    const first = await c.consume('v', 25, 'idem-3'); // Basic allows 20 -> rejected
    expect(first.body.accepted).toBe(false);
    await c.put('/v1/users/v/plan', { planId: 'premium' });
    const again = await c.consume('v', 25, 'idem-3');
    expect(again.body).toMatchObject({ accepted: false, replayed: true });
    // a NEW request id is evaluated against the new plan
    expect((await c.consume('v', 25, 'idem-3b')).body.accepted).toBe(true);
  });
  it('reusing a requestId for a different request is a 409 and counts nothing', async () => {
    const before = (await c.get('/v1/usage')).body.account.consumed;
    const r1 = await c.consume('u', 11, 'idem-1'); // other units
    const r2 = await c.consume('v', 10, 'idem-1'); // other user
    for (const r of [r1, r2]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('idempotency_conflict');
    }
    expect((await c.get('/v1/usage')).body.account.consumed).toBe(before);
  });
  it('request ids are scoped per account', async () => {
    const other = await env.newAccount();
    await other.makeUser('u');
    expect((await other.consume('u', 5, 'idem-1')).body).toMatchObject({ accepted: true, replayed: false });
  });
  it('concurrent duplicates (retry storm) are counted exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => c.consume('u', 7, 'storm-1')));
    expect(results.every((r) => r.status === 200 && r.body.accepted === true)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    const logged = await env.pool.query(`SELECT count(*)::int AS n FROM consume_requests WHERE account_id = $1 AND request_id = 'storm-1'`, [c.accountId]);
    expect(logged.rows[0].n).toBe(1);
  });
});
