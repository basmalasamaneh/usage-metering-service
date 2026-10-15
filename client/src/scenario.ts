import { type Json, QuotaClient, ServiceError } from './quotaClient';

export interface Step {
  title: string;
  detail: string;
  accepted?: boolean;
  reason?: string;
  replayed?: boolean;
  balances?: string;
  expectation: string;
  ok: boolean;
}
export interface ScenarioResult {
  account: string;
  steps: Step[];
  passed: boolean;
}

/**
 * Guided scenario. It creates its own fresh account, so results are deterministic and independent of
 * the interactive desk. Everything is done through the public API; plans change at runtime.
 */
export async function runScenario(baseUrl: string, adminToken?: string): Promise<ScenarioResult> {
  const c = new QuotaClient(baseUrl, undefined, adminToken);
  await c.waitUntilHealthy();
  const created = await c.createAccount(`Scenario ${new Date().toISOString()}`);
  c.apiKey = created.apiKey;

  const steps: Step[] = [];
  const team = await c.post('/v1/plans', { scope: 'account', name: 'Team', monthlyAllowance: 100, maxUnitsPerRequest: 50 });
  const light = await c.post('/v1/plans', { scope: 'user', name: 'Light', monthlyAllowance: 30, maxUnitsPerRequest: 10 });
  const heavy = await c.post('/v1/plans', { scope: 'user', name: 'Heavy', monthlyAllowance: 80, maxUnitsPerRequest: 40 });
  await c.put('/v1/account/plan', { planId: team.id });
  await c.post('/v1/users', { userId: 'alice', planId: light.id });
  await c.post('/v1/users', { userId: 'bob', planId: heavy.id });
  steps.push({
    title: 'Setup',
    detail: 'Account plan "Team": 100 units/month, 50 per request. alice on "Light" (30/month, 10 per request), bob on "Heavy" (80/month, 40 per request).',
    expectation: 'two users, different plans, one shared account allowance',
    ok: true,
  });

  let n = 0;
  const run = async (
    title: string,
    userId: string,
    units: number,
    expect: { accepted: boolean; level?: 'user' | 'account'; rule?: string },
    requestId = `scn-${++n}`,
  ) => {
    const d: Json = await c.consume(userId, units, requestId);
    const ok =
      d.accepted === expect.accepted &&
      (!expect.level || d.reason?.level === expect.level) &&
      (!expect.rule || d.reason?.rule === expect.rule);
    steps.push({
      title,
      detail: `${userId} processes a ${units}-unit document (requestId ${requestId})`,
      accepted: d.accepted,
      reason: d.reason ? `${d.reason.level} · ${d.reason.rule} — ${d.reason.message}` : undefined,
      replayed: d.replayed,
      balances: `${userId}: ${d.user.consumed}/${d.user.monthlyAllowance ?? '∞'} used · account: ${d.account.consumed}/${d.account.monthlyAllowance ?? '∞'} used`,
      expectation: expect.accepted ? 'accepted' : `rejected by the ${expect.level} ${expect.rule}`,
      ok,
    });
    return requestId;
  };

  await run('Accepted action', 'alice', 8, { accepted: true });
  await run('Rejected by a USER limit', 'alice', 15, { accepted: false, level: 'user', rule: 'max_units_per_request' });
  await run('bob uses his allowance', 'bob', 40, { accepted: true });
  await run('bob again (his 80/month is now used up)', 'bob', 40, { accepted: true });
  await run('alice uses more', 'alice', 10, { accepted: true });
  const blocked = await run('Rejected by the shared ACCOUNT limit (alice still has 12 left of her own)', 'alice', 5, {
    accepted: false, level: 'account', rule: 'monthly_allowance',
  });
  await run('Retry of the previous request after a timeout: same decision, nothing counted twice', 'alice', 5, {
    accepted: false, level: 'account', rule: 'monthly_allowance',
  }, blocked).then(async () => {
    const last = steps[steps.length - 1] as Step;
    last.ok = last.ok && last.replayed === true;
  });

  await c.patch(`/v1/plans/${team.id}`, { monthlyAllowance: 200 });
  steps.push({
    title: 'Configure: raise the account plan to 200 units/month (PATCH /v1/plans/:id)',
    detail: 'No redeploy, no client change.',
    expectation: 'takes effect for the next request',
    ok: true,
  });
  await run('Same request size as the rejected one, now accepted', 'alice', 5, { accepted: true });

  await c.put('/v1/users/alice/plan', { planId: heavy.id });
  steps.push({
    title: 'Switch: alice moves from "Light" to "Heavy" (PUT /v1/users/alice/plan)',
    detail: 'Her already consumed units are kept; she does not get a fresh allowance.',
    expectation: 'consumed preserved',
    ok: true,
  });
  await run('The 15-unit document that was rejected before is now accepted', 'alice', 15, { accepted: true });

  await c.patch(`/v1/plans/${team.id}`, { monthlyAllowance: 50 });
  const q = await c.get('/v1/users/alice/usage');
  steps.push({
    title: 'Configure: lower the account allowance to 50, below the units already used',
    detail: `Account remaining now reads ${q.account.remaining}.`,
    expectation: 'remaining shows 0',
    ok: q.account.remaining === 0,
  });
  await run('alice still has her own allowance, but the account is now over its limit: rejected', 'alice', 1, {
    accepted: false, level: 'account', rule: 'monthly_allowance',
  });

  return { account: created.account.id, steps, passed: steps.every((s) => s.ok) };
}

export { ServiceError };
