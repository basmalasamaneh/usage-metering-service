import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ConsumeCoordinator } from './accounting/coordinator';
import type { Config } from './config';
import { type Clock, systemClock } from './domain/period';
import { checkAdminToken, createApiKeyAuth } from './http/auth';
import type { AppContext } from './http/context';
import { HttpError, pgCode } from './http/errors';
import { registerAccountCreation, registerAccountRoutes } from './http/routes/accounts';
import { registerConsumeRoutes } from './http/routes/consume';
import { registerPlanRoutes } from './http/routes/plans';
import { registerUsageRoutes } from './http/routes/usage';
import { registerUserRoutes } from './http/routes/users';

export interface AppDeps {
  pool: Pool;
  config: Config;
  clock?: Clock;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool, config } = deps;
  const clock = deps.clock ?? systemClock;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    maxParamLength: 256, // ids may be up to 128 chars (Fastify's default limit is 100); longer ones get a clean 400
  });
  const ctx: AppContext = { pool, config, clock, coordinator: new ConsumeCoordinator(pool, clock, config.batchMax) };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Fastify's own 4xx errors (malformed JSON, unsupported media type, body too large, ...).
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error({ err, pg: pgCode(err) }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error. Safe to retry with the same requestId.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'route_not_found', message: 'No such endpoint.' } }));

  // Public
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  // Operational numbers: guarded by the same optional admin token as account creation.
  app.get('/stats', async (req) => {
    checkAdminToken(config.adminToken, req);
    return {
      consume: ctx.coordinator.stats(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    };
  });
  registerAccountCreation(app, ctx);

  // Everything below requires a valid X-API-Key; `req.accountId` is the only identity the handlers use.
  await app.register(async (authed) => {
    authed.addHook('onRequest', createApiKeyAuth(pool));
    registerAccountRoutes(authed, ctx);
    registerPlanRoutes(authed, ctx);
    registerUserRoutes(authed, ctx);
    registerUsageRoutes(authed, ctx);
    registerConsumeRoutes(authed, ctx);
  });

  return app;
}
