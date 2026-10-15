import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  // Wait for the database (compose starts both at once), then migrate + seed predefined plans.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for database (${attempt}/30): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await migrate(pool, config.migrationsDir, (m) => console.log(m));

  const app = await buildApp({ pool, config });
  await app.listen({ host: config.host, port: config.port });
  if (!config.adminToken) {
    app.log.warn('ADMIN_TOKEN is not set: POST /v1/accounts and GET /stats are open. Set ADMIN_TOKEN in any shared environment.');
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close(); // stops accepting, waits for in-flight requests
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
