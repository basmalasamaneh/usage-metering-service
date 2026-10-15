import type { FastifyInstance } from 'fastify';
import { checkAdminToken, generateApiKey } from '../auth';
import { HttpError, FK_VIOLATION, notFound, pgCode } from '../errors';
import { createAccountBody, parse, setPlanBody } from '../schemas';
import { planView } from '../views';
import { getAccount, insertAccount, setAccountPlan } from '../../repo/accounts';
import { getPredefinedPlan, getVisiblePlan } from '../../repo/plans';
import type { AppContext } from '../context';
import type { AccountRow } from '../../repo/accounts';

const accountView = (a: AccountRow) => ({
  id: a.id,
  name: a.name,
  apiKeyPrefix: a.api_key_prefix,
  plan: planView(a.plan),
  createdAt: a.created_at.toISOString(),
});

/** POST /v1/accounts: the bootstrap operation (no API key exists yet). Optionally guarded by ADMIN_TOKEN. */
export function registerAccountCreation(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/accounts', async (req, reply) => {
    checkAdminToken(ctx.config.adminToken, req);
    const body = parse(createAccountBody, req.body);
    const planId = body.planId ?? 'starter';
    const plan = await getPredefinedPlan(ctx.pool, planId); // a new account has no custom plans yet
    if (!plan) throw new HttpError(422, 'plan_not_found', `Plan "${planId}" does not exist. New accounts can start on a predefined plan.`);
    if (plan.scope !== 'account') throw new HttpError(422, 'plan_scope_mismatch', `Plan "${planId}" is a ${plan.scope} plan, not an account plan.`);

    const { key, hash, prefix } = generateApiKey();
    const id = await insertAccount(ctx.pool, { name: body.name, planId, keyHash: hash, keyPrefix: prefix });
    const account = (await getAccount(ctx.pool, id)) as AccountRow;
    reply.code(201);
    return {
      account: accountView(account),
      apiKey: key, // shown once: only its hash is stored
      notice: 'Store this API key now. It cannot be retrieved again.',
    };
  });
}

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/account', async (req) => {
    const account = await getAccount(ctx.pool, req.accountId);
    if (!account) throw notFound('Account');
    return accountView(account);
  });

  app.put('/v1/account/plan', async (req) => {
    const { planId } = parse(setPlanBody, req.body);
    const plan = await getVisiblePlan(ctx.pool, req.accountId, planId);
    if (!plan) throw new HttpError(404, 'plan_not_found', `Plan "${planId}" not found.`);
    if (plan.scope !== 'account') throw new HttpError(422, 'plan_scope_mismatch', `Plan "${planId}" is a user plan and cannot be assigned to the account.`);
    try {
      await setAccountPlan(ctx.pool, req.accountId, planId);
    } catch (err) {
      if (pgCode(err) === FK_VIOLATION) throw new HttpError(409, 'plan_deleted', 'The plan was deleted concurrently.');
      throw err;
    }
    return accountView((await getAccount(ctx.pool, req.accountId)) as AccountRow);
  });
}
