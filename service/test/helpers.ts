import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import type { Clock } from '../src/domain/period';

export const BASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/quota';

export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-10-15T12:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export class Client {
  constructor(
    private readonly app: FastifyInstance,
    public readonly key: string | undefined,
    public readonly accountId = '',
  ) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Res> {
    const res = await this.app.inject({
      method,
      url,
      headers: this.key ? { 'x-api-key': this.key } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body);
  put = (url: string, body?: unknown) => this.req('PUT', url, body);
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body);
  del = (url: string) => this.req('DELETE', url);

  consume(userId: string, units: number, requestId: string): Promise<Res> {
    return this.post('/v1/consume', { userId, units, requestId });
  }
  async makePlan(scope: 'account' | 'user', name: string, monthlyAllowance: number | null, maxUnitsPerRequest: number | null): Promise<string> {
    const r = await this.post('/v1/plans', { scope, name, monthlyAllowance, maxUnitsPerRequest });
    if (r.status !== 201) throw new Error(`makePlan failed: ${JSON.stringify(r.body)}`);
    return r.body.id;
  }
  async makeUser(userId: string, planId?: string): Promise<void> {
    const r = await this.post('/v1/users', { userId, ...(planId ? { planId } : {}) });
    if (r.status !== 201) throw new Error(`makeUser failed: ${JSON.stringify(r.body)}`);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export interface TestEnv {
  app: FastifyInstance;
  pool: Pool;
  clock: FakeClock;
  config: Config;
  schema: string;
  anonymous: Client;
  withKey(key: string): Client;
  newAccount(name?: string, planId?: string): Promise<Client>;
  close(): Promise<void>;
}

/** Each env gets its own PostgreSQL schema => isolated, parallel-safe, no cleanup between tests. */
export async function createEnv(opts: { batchMax?: number; adminToken?: string; clock?: FakeClock } = {}): Promise<TestEnv> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const config = loadConfig({
    DATABASE_URL: BASE_URL,
    DB_SCHEMA: schema,
    LOG_LEVEL: 'silent',
    DB_POOL_MAX: '20',
    BATCH_MAX: String(opts.batchMax ?? 64),
    MIGRATIONS_DIR: path.join(__dirname, '..', 'migrations'),
    ...(opts.adminToken ? { ADMIN_TOKEN: opts.adminToken } : {}),
  });
  const pool = createPool(config);
  await migrate(pool, config.migrationsDir);
  const clock = opts.clock ?? new FakeClock();
  const app = await buildApp({ pool, config, clock });
  await app.ready();

  let n = 0;
  return {
    app,
    pool,
    clock,
    config,
    schema,
    anonymous: new Client(app, undefined),
    withKey: (key) => new Client(app, key),
    async newAccount(name = `acct-${++n}`, planId?: string) {
      const res = await new Client(app, undefined).post('/v1/accounts', { name, ...(planId ? { planId } : {}) });
      if (res.status !== 201) throw new Error(`newAccount failed: ${JSON.stringify(res.body)}`);
      return new Client(app, res.body.apiKey, res.body.account.id);
    },
    async close() {
      await app.close();
      await pool.end();
      const cleanup = new Pool({ connectionString: BASE_URL, max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}

/**
 * The accounting invariants that must hold after ANY sequence of requests:
 *   account_usage == sum(user_usage) == sum(units of accepted requests), per month.
 */
export async function assertInvariants(env: TestEnv, accountId: string): Promise<{ accepted: number }> {
  const q = async (sql: string) => (await env.pool.query(sql, [accountId])).rows;
  const acct = await q(`SELECT period::text, consumed FROM account_usage WHERE account_id = $1 ORDER BY period`);
  const users = await q(
    `SELECT uu.period::text, sum(uu.consumed)::bigint AS consumed FROM user_usage uu
       JOIN users u ON u.id = uu.user_id WHERE u.account_id = $1 GROUP BY uu.period ORDER BY uu.period`,
  );
  const log = await q(
    `SELECT period::text, coalesce(sum(units) FILTER (WHERE accepted), 0)::bigint AS consumed
       FROM consume_requests WHERE account_id = $1 GROUP BY period ORDER BY period`,
  );
  const norm = (rows: { period: string; consumed: number }[]) =>
    rows.filter((r) => Number(r.consumed) > 0).map((r) => `${r.period}:${Number(r.consumed)}`);
  if (JSON.stringify(norm(acct)) !== JSON.stringify(norm(users)) || JSON.stringify(norm(acct)) !== JSON.stringify(norm(log))) {
    throw new Error(`invariant broken: account=${norm(acct)} users=${norm(users)} log=${norm(log)}`);
  }
  return { accepted: log.reduce((s, r) => s + Number(r.consumed), 0) };
}
