import type { FastifyInstance } from 'fastify';
import { HttpError, notFound } from '../errors';
import { createPlanBody, parse, planListQuery, updatePlanBody } from '../schemas';
import { planView } from '../views';
import { createPlan, deletePlan, getVisiblePlan, listPlans, updatePlan } from '../../repo/plans';
import type { AppContext } from '../context';

export function registerPlanRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/plans', async (req) => {
    const { scope } = parse(planListQuery, req.query);
    return { data: (await listPlans(ctx.pool, req.accountId, scope)).map(planView) };
  });

  app.post('/v1/plans', async (req, reply) => {
    const body = parse(createPlanBody, req.body);
    const plan = await createPlan(ctx.pool, req.accountId, body);
    reply.code(201);
    return planView(plan);
  });

  app.get<{ Params: { planId: string } }>('/v1/plans/:planId', async (req) => {
    const plan = await getVisiblePlan(ctx.pool, req.accountId, req.params.planId);
    if (!plan) throw notFound('Plan');
    return planView(plan);
  });

  app.patch<{ Params: { planId: string } }>('/v1/plans/:planId', async (req) => {
    const existing = await getVisiblePlan(ctx.pool, req.accountId, req.params.planId);
    if (!existing) throw notFound('Plan');
    if (existing.account_id === null) throw new HttpError(403, 'plan_read_only', 'Predefined plans are read-only. Create a custom plan instead.');
    const patch = parse(updatePlanBody, req.body);
    const updated = await updatePlan(ctx.pool, req.accountId, existing.id, patch);
    if (!updated) throw notFound('Plan');
    return planView(updated);
  });

  app.delete<{ Params: { planId: string } }>('/v1/plans/:planId', async (req, reply) => {
    const existing = await getVisiblePlan(ctx.pool, req.accountId, req.params.planId);
    if (!existing) throw notFound('Plan');
    if (existing.account_id === null) throw new HttpError(403, 'plan_read_only', 'Predefined plans are read-only.');
    if (!(await deletePlan(ctx.pool, req.accountId, existing.id))) throw notFound('Plan');
    reply.code(204);
  });
}
