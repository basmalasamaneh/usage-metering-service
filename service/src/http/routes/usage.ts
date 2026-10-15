import type { FastifyInstance } from 'fastify';
import { monthOf, periodFromMonth, periodOf } from '../../domain/period';
import { maxAcceptableUnits } from '../../domain/rules';
import { getAccountUsage, getUserQuota, listMonths, listUserUsage } from '../../repo/usage';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { decodeCursor, encodeCursor, monthsQuery, parse, userIdParam, usageQuery, userUsageQuery } from '../schemas';
import { toLevelState, usageView } from '../views';

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const resolveMonth = (month: string | undefined) => {
    const current = periodOf(ctx.clock.now());
    const period = month ? (periodFromMonth(month) as string) : current;
    return { period, isCurrent: period === current };
  };

  /** Account-level usage plus the usage of every registered user, for one month (default: current). */
  app.get('/v1/usage', async (req) => {
    const q = parse(usageQuery, req.query);
    const { period, isCurrent } = resolveMonth(q.month);
    const account = await getAccountUsage(ctx.pool, req.accountId, period);
    const rows = await listUserUsage(ctx.pool, req.accountId, period, q.limit + 1, decodeCursor(q.cursor));
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      month: monthOf(period),
      isCurrentMonth: isCurrent,
      account: usageView(account, isCurrent),
      users: {
        data: page.map((r) => ({ userId: r.userId, ...usageView(r, isCurrent) })),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.pk) : null,
      },
    };
  });

  /** Months in which the account consumed anything (for browsing previous months). */
  app.get('/v1/usage/months', async (req) => {
    const q = parse(monthsQuery, req.query);
    const rows = await listMonths(ctx.pool, req.accountId, q.limit);
    return { data: rows.map((r) => ({ month: monthOf(r.period), consumed: r.consumed })) };
  });

  /**
   * One user: consumed/remaining at both levels, the plans and limits applied to each, and
   * (current month only) the largest request that would be accepted right now.
   */
  app.get<{ Params: { userId: string } }>('/v1/users/:userId/usage', async (req) => {
    const { userId } = parse(userIdParam, req.params);
    const q = parse(userUsageQuery, req.query);
    const { period, isCurrent } = resolveMonth(q.month);
    const quota = await getUserQuota(ctx.pool, req.accountId, userId, period);
    if (!quota) throw notFound('User');
    return {
      userId,
      month: monthOf(period),
      isCurrentMonth: isCurrent,
      user: usageView(quota.user, isCurrent),
      account: usageView(quota.account, isCurrent),
      maxAcceptableUnits: isCurrent
        ? maxAcceptableUnits([toLevelState('user', quota.user), toLevelState('account', quota.account)])
        : null,
    };
  });
}
