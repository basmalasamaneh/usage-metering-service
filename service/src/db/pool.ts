import { Pool, types } from 'pg';
import type { Config } from '../config';

// bigint (int8) -> JS number. All counters are bounded far below 2^53 by input validation.
types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint value ${v} exceeds the safe integer range`);
  return n;
});
// date -> 'YYYY-MM-DD' string (no timezone conversion surprises).
types.setTypeParser(1082, (v) => v);

export function createPool(cfg: Pick<Config, 'databaseUrl' | 'dbPoolMax' | 'dbSchema' | 'synchronousCommit'>): Pool {
  const options = [`-c synchronous_commit=${cfg.synchronousCommit}`];
  if (cfg.dbSchema) options.push(`-c search_path=${cfg.dbSchema}`);
  const pool = new Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    options: options.join(' '),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // An idle client died (e.g. database restart). The pool discards it; nothing else to do.
    console.error('idle postgres client error:', err.message);
  });
  return pool;
}
