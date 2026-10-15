import type { FastifyInstance } from 'fastify';
import { FK_VIOLATION, HttpError, notFound, pgCode } from '../errors';
import { createUserBody, decodeCursor, encodeCursor, pageQuery, parse, setPlanBody, userIdParam } from '../schemas';
import { planView } from '../views';
import { getVisiblePlan } from '../../repo/plans';
import { getUser, insertUser, listUsers, setUserPlan } from '../../repo/users';
import type { UserRow } from '../../repo/users';
import type { AppContext } from '../context';

const DEFAULT_USER_PLAN = 'basic';

const userView = (u: UserRow) => ({ userId: u.user_id, plan: planView(u.plan), createdAt: u.created_at.toISOString() });

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function resolveUserPlan(accountId: string, planId: string) {
    const plan = await getVisiblePlan(ctx.pool, accountId, planId);
    if (!plan) throw new HttpError(404, 'plan_not_found', `Plan "${planId}" not found.`);
    if (plan.scope !== 'user') throw new HttpError(422, 'plan_scope_mismatch', `Plan "${planId}" is an account plan and cannot be assigned to a user.`);
    return plan;
  }

  app.post('/v1/users', async (req, reply) => {
    const body = parse(createUserBody, req.body);
    const plan = await resolveUserPlan(req.accountId, body.planId ?? DEFAULT_USER_PLAN);
    try {
      await insertUser(ctx.pool, req.accountId, body.userId, plan.id);
    } catch (err) {
      if (pgCode(err) === FK_VIOLATION) throw new HttpError(409, 'plan_deleted', 'The plan was deleted concurrently.');
      throw err;
    }
    reply.code(201);
    return userView((await getUser(ctx.pool, req.accountId, body.userId)) as UserRow);
  });

  app.get('/v1/users', async (req) => {
    const q = parse(pageQuery, req.query);
    const rows = await listUsers(ctx.pool, req.accountId, q.limit + 1, decodeCursor(q.cursor));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: page.map(userView), nextCursor: rows.length > q.limit && last ? encodeCursor(last.pk) : null };
  });

  app.get<{ Params: { userId: string } }>('/v1/users/:userId', async (req) => {
    const { userId } = parse(userIdParam, req.params);
    const user = await getUser(ctx.pool, req.accountId, userId);
    if (!user) throw notFound('User'); // also what another account's user looks like: existence is never leaked
    return userView(user);
  });

  app.put<{ Params: { userId: string } }>('/v1/users/:userId/plan', async (req) => {
    const { userId } = parse(userIdParam, req.params);
    const { planId } = parse(setPlanBody, req.body);
    const plan = await resolveUserPlan(req.accountId, planId);
    let changed: boolean;
    try {
      changed = await setUserPlan(ctx.pool, req.accountId, userId, plan.id);
    } catch (err) {
      if (pgCode(err) === FK_VIOLATION) throw new HttpError(409, 'plan_deleted', 'The plan was deleted concurrently.');
      throw err;
    }
    if (!changed) throw notFound('User');
    return userView((await getUser(ctx.pool, req.accountId, userId)) as UserRow);
  });
}
