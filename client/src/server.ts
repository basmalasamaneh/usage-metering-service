import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ensureDesk, overview } from './desk';
import { QuotaClient, ServiceError } from './quotaClient';
import { runScenario } from './scenario';

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || undefined;
const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'data', 'state.json');
const PORT = Number(process.env.PORT ?? 8080);

async function main() {
  // The browser never sees the API key: this backend holds it and calls the service for the users.
  const client = new QuotaClient(SERVICE_URL, process.env.QUOTA_API_KEY, ADMIN_TOKEN);
  if (process.env.QUOTA_API_KEY) await client.waitUntilHealthy();
  else await ensureDesk(client, STATE_FILE);

  const app = Fastify({ logger: { level: 'info' } });
  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ServiceError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    app.log.error(err);
    return reply.code(500).send({ error: { code: 'client_error', message: err.message } });
  });

  app.get('/api/overview', () => overview(client));

  // "Process a document": the only business action. The client asks the service for permission by consuming units.
  app.post<{ Body: { userId: string; units: number; requestId?: string } }>('/api/process', async (req) => {
    const { userId, units } = req.body;
    const requestId = req.body.requestId || `doc-${randomUUID()}`;
    return client.consume(userId, Number(units), requestId);
  });

  app.put<{ Params: { id: string }; Body: { planId: string } }>('/api/users/:id/plan', (req) =>
    client.put(`/v1/users/${encodeURIComponent(req.params.id)}/plan`, { planId: req.body.planId }));
  app.put<{ Body: { planId: string } }>('/api/account/plan', (req) => client.put('/v1/account/plan', { planId: req.body.planId }));
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/plans/:id', (req) =>
    client.patch(`/v1/plans/${encodeURIComponent(req.params.id)}`, req.body));

  app.post('/api/demo/run', () => runScenario(SERVICE_URL, ADMIN_TOKEN));
  app.post('/api/reset', async () => {
    await ensureDesk(client, STATE_FILE, true);
    return { ok: true };
  });

  await app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public') });
  await app.listen({ host: '0.0.0.0', port: PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
