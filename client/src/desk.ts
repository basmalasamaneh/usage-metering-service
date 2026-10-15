import fs from 'node:fs';
import path from 'node:path';
import { type Json, QuotaClient, ServiceError } from './quotaClient';

interface DeskState {
  apiKey: string;
  accountId: string;
}

/**
 * The "document desk": the interactive demo account. Its API key is kept in a state file (a docker
 * volume) so restarting the client keeps the same account and usage; if the service database was
 * wiped, the key no longer works and a new demo account is created automatically.
 */
export async function ensureDesk(client: QuotaClient, stateFile: string, forceNew = false): Promise<DeskState> {
  await client.waitUntilHealthy();
  if (!forceNew) {
    const saved = readState(stateFile);
    if (saved) {
      client.apiKey = saved.apiKey;
      try {
        await client.get('/v1/account');
        return saved;
      } catch (err) {
        if (!(err instanceof ServiceError) || err.status !== 401) throw err;
        console.log('saved API key no longer valid (database was reset); creating a new demo account');
      }
    }
  }
  client.apiKey = undefined;
  const created = await client.createAccount('Pagewise (demo)');
  client.apiKey = created.apiKey as string;
  const state: DeskState = { apiKey: created.apiKey, accountId: created.account.id };

  // Demo configuration, created ONLY through the public API: 3 custom plans and 3 users.
  const team = await client.post('/v1/plans', { scope: 'account', name: 'Team', monthlyAllowance: 200, maxUnitsPerRequest: 100 });
  const light = await client.post('/v1/plans', { scope: 'user', name: 'Light reader', monthlyAllowance: 60, maxUnitsPerRequest: 20 });
  const heavy = await client.post('/v1/plans', { scope: 'user', name: 'Power user', monthlyAllowance: 150, maxUnitsPerRequest: 50 });
  await client.put('/v1/account/plan', { planId: team.id });
  await client.post('/v1/users', { userId: 'alice', planId: light.id });
  await client.post('/v1/users', { userId: 'carol', planId: light.id });
  await client.post('/v1/users', { userId: 'bob', planId: heavy.id });
  writeState(stateFile, state);
  return state;
}

function readState(file: string): DeskState | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DeskState;
  } catch {
    return null;
  }
}
function writeState(file: string, s: DeskState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s));
}

/** Everything the page needs in one call. */
export async function overview(client: QuotaClient): Promise<Json> {
  const [account, plans, usage, requests] = await Promise.all([
    client.get('/v1/account'),
    client.get('/v1/plans'),
    client.get('/v1/usage?limit=200'),
    client.get('/v1/requests?limit=12'),
  ]);
  return { account, plans: plans.data, usage, requests: requests.data };
}
