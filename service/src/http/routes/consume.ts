import type { FastifyInstance } from 'fastify';
import { periodFromMonth } from '../../domain/period';
import { getRequest, listRequests } from '../../repo/requests';
import { getUser } from '../../repo/users';
import type { AppContext } from '../context';
import { HttpError, notFound } from '../errors';
import { consumeBody, decodeCursor, encodeCursor, historyQuery, parse, requestIdParam } from '../schemas';
import { decisionView } from '../views';

export function registerConsumeRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Both outcomes are HTTP 200: a rejection is a successful evaluation, and a retry of any
   * request returns the identical status and body (plus replayed=true).
   */
  app.post('/v1/consume', async (req) => {
    const body = parse(consumeBody, req.body);
    const outcome = await ctx.coordinator.submit(req.accountId, body);
    switch (outcome.kind) {
      case 'decision':
        return decisionView(outcome.decision, outcome.replayed);
      case 'user_not_found':
        // Same answer for "does not exist" and "belongs to another account".
        throw new HttpError(404, 'user_not_found', `User "${body.userId}" is not registered in this account.`);
      case 'idempotency_conflict':
        throw new HttpError(
          409,
          'idempotency_conflict',
          `requestId "${body.requestId}" was already used for a different request (user "${outcome.existing.userId}", ${outcome.existing.units} units). Use a new requestId.`,
        );
    }
  });

  app.get('/v1/requests', async (req) => {
    const q = parse(historyQuery, req.query);
    let userPk: number | undefined;
    if (q.userId) {
      const user = await getUser(ctx.pool, req.accountId, q.userId);
      if (!user) throw notFound('User');
      userPk = user.pk;
    }
    const rows = await listRequests(ctx.pool, req.accountId, {
      userPk,
      period: q.month ? (periodFromMonth(q.month) as string) : undefined,
      accepted: q.outcome ? q.outcome === 'accepted' : undefined,
      beforeSeq: decodeCursor(q.cursor) ?? undefined,
      limit: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => decisionView(r.decision, false)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.seq) : null,
    };
  });

  app.get<{ Params: { requestId: string } }>('/v1/requests/:requestId', async (req) => {
    const { requestId } = parse(requestIdParam, req.params);
    const item = await getRequest(ctx.pool, req.accountId, requestId);
    if (!item) throw notFound('Request');
    return decisionView(item.decision, false);
  });
}
