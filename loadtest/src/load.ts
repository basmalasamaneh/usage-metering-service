/**
 * Load + correctness harness. It talks to the service over HTTP only (so it also runs from docker compose).
 *
 *   tsx src/load.ts --scenario all --url http://localhost:3000 --duration 10 --concurrency 64 --label baseline
 *
 * Scenarios
 *   spread   many accounts, everything accepted           -> raw throughput when accounts do not contend
 *   hot      ONE account, many users, everything accepted -> worst case: all requests serialise on one account
 *   exhaust  ONE account with a small allowance           -> correctness: never over-spend, every rejection justified
 *   storm    every request sent 3x concurrently, same id  -> idempotency: counted exactly once
 *   churn    hot account while its plan is edited non-stop-> correctness while rules change
 *
 * After each scenario the harness asks the service for the totals and compares them with what it
 * observed in the responses. Any mismatch fails the run (exit code 1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'undici';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------------------------------ args
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set((process.argv[i] ?? '').replace(/^--/, ''), process.argv[i + 1] ?? '');
const URL_ = args.get('url') ?? process.env.SERVICE_URL ?? 'http://localhost:3000';
const SCENARIO = args.get('scenario') ?? 'all';
const DURATION_S = Number(args.get('duration') ?? 10);
const CONCURRENCY = Number(args.get('concurrency') ?? 64);
const LABEL = args.get('label') ?? 'run';
const OUT = args.get('out') ?? path.join('results', `${LABEL}.json`);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const pool = new Pool(URL_, { connections: Math.max(CONCURRENCY + 8, 16), pipelining: 1 });

async function http(method: string, p: string, key?: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {};
  if (key) headers['x-api-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ADMIN_TOKEN && (p === '/v1/accounts' || p === '/stats')) headers['x-admin-token'] = ADMIN_TOKEN;
  const res = await pool.request({ method: method as 'GET', path: p, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.body.text();
  return { status: res.statusCode, json: text ? JSON.parse(text) : null };
}

// ------------------------------------------------------------------------------------------ setup
interface Acct {
  key: string;
  accountPlanId: string;
  users: string[];
  accepted: number; // units the harness saw accepted
  unitsByRequest: Map<string, number>;
}

async function createAccount(name: string, accountAllowance: number | null, userCount: number, userAllowance: number | null = null): Promise<Acct> {
  const created = await http('POST', '/v1/accounts', undefined, { name });
  if (created.status !== 201) throw new Error(`create account failed: ${JSON.stringify(created.json)}`);
  const key = created.json.apiKey as string;
  const ap = await http('POST', '/v1/plans', key, { scope: 'account', name: 'lt-account', monthlyAllowance: accountAllowance, maxUnitsPerRequest: null });
  await http('PUT', '/v1/account/plan', key, { planId: ap.json.id });
  const up = await http('POST', '/v1/plans', key, { scope: 'user', name: 'lt-user', monthlyAllowance: userAllowance, maxUnitsPerRequest: null });
  const users: string[] = [];
  for (let i = 0; i < userCount; i++) {
    const userId = `user-${i}`;
    const r = await http('POST', '/v1/users', key, { userId, planId: up.json.id });
    if (r.status !== 201) throw new Error(`create user failed: ${JSON.stringify(r.json)}`);
    users.push(userId);
  }
  return { key, accountPlanId: ap.json.id, users, accepted: 0, unitsByRequest: new Map() };
}

// ------------------------------------------------------------------------------------------ runner
interface Stats { count: number; errors: number; rps: number; p50: number; p95: number; p99: number; max: number; elapsedS: number }

function summarize(lat: number[], errors: number, elapsedMs: number): Stats {
  const s = [...lat].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number) : 0);
  return { count: s.length, errors, rps: Math.round(s.length / (elapsedMs / 1000)), p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(s[s.length - 1] ?? 0), elapsedS: round(elapsedMs / 1000) };
}
const round = (n: number) => Math.round(n * 100) / 100;

/** `concurrency` workers loop until `until()` is true. `task` returns false for a failed request. */
async function drive(until: () => boolean, task: (worker: number, seq: number) => Promise<boolean>): Promise<Stats> {
  const lat: number[] = [];
  let errors = 0;
  let seq = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    while (!until()) {
      const t = performance.now();
      let ok = false;
      try { ok = await task(w, seq++); } catch { ok = false; }
      lat.push(performance.now() - t);
      if (!ok) errors++;
    }
  }));
  return summarize(lat, errors, performance.now() - t0);
}
const forSeconds = (s: number) => { const end = Date.now() + s * 1000; return () => Date.now() >= end; };
const untilCount = (n: number) => { let c = 0; return () => c++ >= n; };

async function serverStats(): Promise<Json> { return (await http('GET', '/stats')).json; }

/** Compares what the service reports with what the harness observed. Returns a list of problems. */
async function verify(a: Acct, label: string): Promise<string[]> {
  const problems: string[] = [];
  const usage = (await http('GET', '/v1/usage?limit=200', a.key)).json;
  const total = usage.account.consumed as number;
  let usersSum = 0;
  let cursor: string | null = null;
  let page = usage.users;
  for (;;) {
    usersSum += page.data.reduce((s: number, u: Json) => s + u.consumed, 0);
    cursor = page.nextCursor;
    if (!cursor) break;
    page = (await http('GET', `/v1/usage?limit=200&cursor=${cursor}`, a.key)).json.users;
  }
  if (total !== a.accepted) problems.push(`${label}: service says account consumed ${total}, harness saw ${a.accepted} accepted`);
  if (usersSum !== total) problems.push(`${label}: sum of users ${usersSum} != account ${total}`);
  return problems;
}

interface Result { scenario: string; stats: Stats; extra: Json; problems: string[] }

// ------------------------------------------------------------------------------------------ scenarios
async function consumeOnce(a: Acct, userId: string, units: number, requestId: string): Promise<{ ok: boolean; body: Json }> {
  const r = await http('POST', '/v1/consume', a.key, { userId, units, requestId });
  return { ok: r.status === 200, body: r.json };
}
function tally(a: Acct, body: Json): void {
  if (body.accepted && !body.replayed && !a.unitsByRequest.has(body.requestId)) {
    a.unitsByRequest.set(body.requestId, body.units);
    a.accepted += body.units;
  }
}

async function spread(): Promise<Result> {
  const accounts = await Promise.all(Array.from({ length: 20 }, (_, i) => createAccount(`spread-${Date.now()}-${i}`, null, 10)));
  const run = `s${Date.now()}`;
  const before = await serverStats();
  const stats = await drive(forSeconds(DURATION_S), async (w, seq) => {
    const a = accounts[(w + seq) % accounts.length] as Acct;
    const r = await consumeOnce(a, a.users[seq % a.users.length] as string, 1 + (seq % 5), `${run}-${w}-${seq}`);
    if (r.ok) tally(a, r.body);
    return r.ok && r.body.accepted === true;
  });
  const after = await serverStats();
  const problems = (await Promise.all(accounts.map((a, i) => verify(a, `spread[${i}]`)))).flat();
  return { scenario: 'spread', stats, extra: batchInfo(before, after, '20 accounts x 10 users'), problems };
}

async function hot(): Promise<Result> {
  const a = await createAccount(`hot-${Date.now()}`, null, 50);
  const run = `h${Date.now()}`;
  const before = await serverStats();
  const stats = await drive(forSeconds(DURATION_S), async (w, seq) => {
    const r = await consumeOnce(a, a.users[seq % a.users.length] as string, 1 + (seq % 5), `${run}-${w}-${seq}`);
    if (r.ok) tally(a, r.body);
    return r.ok && r.body.accepted === true;
  });
  const after = await serverStats();
  return { scenario: 'hot', stats, extra: batchInfo(before, after, '1 account x 50 users'), problems: await verify(a, 'hot') };
}

async function exhaust(): Promise<Result> {
  const ALLOWANCE = 20_000;
  const a = await createAccount(`exhaust-${Date.now()}`, ALLOWANCE, 50);
  const run = `e${Date.now()}`;
  const justified: string[] = [];
  const before = await serverStats();
  const stats = await drive(untilCount(15_000), async (w, seq) => {
    const r = await consumeOnce(a, a.users[seq % a.users.length] as string, 1 + (seq % 5), `${run}-${w}-${seq}`);
    if (!r.ok) return false;
    tally(a, r.body);
    if (!r.body.accepted && !(r.body.reason?.rule === 'monthly_allowance' && r.body.reason.remaining < r.body.units)) justified.push(r.body.requestId);
    return true;
  });
  const after = await serverStats();
  const problems = await verify(a, 'exhaust');
  if (a.accepted > ALLOWANCE) problems.push(`exhaust: OVER-SPENT ${a.accepted} > ${ALLOWANCE}`);
  if (ALLOWANCE - a.accepted >= 5) problems.push(`exhaust: allowance not fully used (${ALLOWANCE - a.accepted} units left although 5-unit requests were rejected)`);
  if (justified.length) problems.push(`exhaust: ${justified.length} rejections were not justified`);
  return { scenario: 'exhaust', stats, extra: { ...batchInfo(before, after, '15,000 requests, allowance 20,000'), acceptedUnits: a.accepted, allowance: ALLOWANCE }, problems };
}

async function storm(): Promise<Result> {
  const a = await createAccount(`storm-${Date.now()}`, null, 20);
  const run = `t${Date.now()}`;
  let replays = 0;
  let sent = 0;
  const before = await serverStats();
  const stats = await drive(forSeconds(DURATION_S), async (w, seq) => {
    const id = `${run}-${w}-${seq}`;
    const userId = a.users[seq % a.users.length] as string;
    const units = 1 + (seq % 4);
    sent += 3;
    const rs = await Promise.all([1, 2, 3].map(() => consumeOnce(a, userId, units, id)));
    for (const r of rs) {
      if (!r.ok) return false;
      if (r.body.replayed) replays++;
      tally(a, r.body);
    }
    return true;
  });
  const after = await serverStats();
  const problems = await verify(a, 'storm');
  const logical = a.unitsByRequest.size;
  if (replays !== sent - logical) problems.push(`storm: expected ${sent - logical} replays, saw ${replays}`);
  return { scenario: 'storm', stats, extra: { ...batchInfo(before, after, 'each request sent 3x concurrently'), httpRequests: sent, logicalRequests: logical, replays }, problems };
}

async function churn(): Promise<Result> {
  const a = await createAccount(`churn-${Date.now()}`, 1_000_000, 30);
  const run = `c${Date.now()}`;
  let stop = false;
  let patches = 0;
  const churner = (async () => {
    let high = false;
    while (!stop) {
      high = !high;
      await http('PATCH', `/v1/plans/${a.accountPlanId}`, a.key, { monthlyAllowance: high ? 1_000_000 : 20_000 });
      patches++;
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  let inconsistent = 0;
  const before = await serverStats();
  const stats = await drive(forSeconds(DURATION_S), async (w, seq) => {
    const r = await consumeOnce(a, a.users[seq % a.users.length] as string, 1 + (seq % 5), `${run}-${w}-${seq}`);
    if (!r.ok) return false;
    tally(a, r.body);
    // an accepted decision must fit inside the allowance it records
    if (r.body.accepted && r.body.account.consumed > r.body.account.monthlyAllowance) inconsistent++;
    return true;
  });
  stop = true;
  await churner;
  const after = await serverStats();
  const problems = await verify(a, 'churn');
  if (inconsistent) problems.push(`churn: ${inconsistent} accepted decisions exceeded the allowance recorded with them`);
  return { scenario: 'churn', stats, extra: { ...batchInfo(before, after, 'hot account, plan edited every ~20ms'), planEdits: patches }, problems };
}

function batchInfo(before: Json, after: Json, note: string): Json {
  const batches = after.consume.batches - before.consume.batches;
  const requests = after.consume.requests - before.consume.requests;
  return { note, avgBatchSize: batches ? round(requests / batches) : 0, maxBatchSize: after.consume.maxBatchSize };
}

// ------------------------------------------------------------------------------------------ main
const ALL: Record<string, () => Promise<Result>> = { spread, hot, exhaust, storm, churn };

async function main() {
  const names = SCENARIO === 'all' ? Object.keys(ALL) : SCENARIO.split(',');
  const results: Result[] = [];
  console.log(`target=${URL_} concurrency=${CONCURRENCY} duration=${DURATION_S}s label=${LABEL}`);
  for (const n of names) {
    const fn = ALL[n];
    if (!fn) throw new Error(`unknown scenario ${n}`);
    process.stdout.write(`running ${n} ... `);
    const r = await fn();
    results.push(r);
    console.log(`${r.stats.rps} req/s  p50 ${r.stats.p50}ms  p95 ${r.stats.p95}ms  p99 ${r.stats.p99}ms  errors ${r.stats.errors}  ${r.problems.length ? 'FAILED' : 'consistent'}`);
    for (const p of r.problems) console.log(`   ✘ ${p}`);
  }
  const server = await serverStats();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL_, concurrency: CONCURRENCY, durationS: DURATION_S, at: new Date().toISOString(), server, results }, null, 2));
  console.log(`wrote ${OUT}`);
  await pool.close();
  process.exit(results.some((r) => r.problems.length || r.stats.errors) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
