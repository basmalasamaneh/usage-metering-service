import path from 'node:path';

export type SyncCommit = 'on' | 'off' | 'local' | 'remote_write' | 'remote_apply';
const SYNC_VALUES: SyncCommit[] = ['on', 'off', 'local', 'remote_write', 'remote_apply'];

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  dbSchema: string | null; // only used by tests to isolate runs
  logLevel: string;
  /** When set, POST /v1/accounts requires `X-Admin-Token`. Unset = open (local/dev). */
  adminToken: string | null;
  /** Maximum number of queued consume requests of one account decided in a single transaction. 1 disables batching. */
  batchMax: number;
  synchronousCommit: SyncCommit;
  migrationsDir: string;
}

function intVar(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sync = (env.DB_SYNCHRONOUS_COMMIT ?? 'on') as SyncCommit;
  if (!SYNC_VALUES.includes(sync)) throw new Error(`DB_SYNCHRONOUS_COMMIT must be one of ${SYNC_VALUES.join(', ')}`);
  return {
    host: env.HOST ?? '0.0.0.0',
    port: intVar(env, 'PORT', 3000, 1, 65535),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/quota',
    dbPoolMax: intVar(env, 'DB_POOL_MAX', 20, 1, 500),
    dbSchema: env.DB_SCHEMA || null,
    logLevel: env.LOG_LEVEL ?? 'info',
    adminToken: env.ADMIN_TOKEN || null,
    batchMax: intVar(env, 'BATCH_MAX', 64, 1, 1000),
    synchronousCommit: sync,
    migrationsDir: env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'migrations'),
  };
}
