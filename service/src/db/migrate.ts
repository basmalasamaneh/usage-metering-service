import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

const MIGRATION_LOCK_KEY = 727_001; // arbitrary constant for pg_advisory_lock

/**
 * Applies pending *.sql files in lexical order, each in its own transaction.
 * An advisory lock makes concurrent starts (several replicas, compose restarts) safe.
 * Predefined plans are seeded by a migration, so a fresh database is usable immediately.
 */
export async function migrate(pool: Pool, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set<string>((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
