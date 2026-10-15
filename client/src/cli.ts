import { runScenario } from './scenario';

/** `npm run demo`: runs the guided scenario in the terminal and exits non-zero if any step deviates. */
async function main() {
  const url = process.env.SERVICE_URL ?? 'http://localhost:3000';
  const result = await runScenario(url, process.env.ADMIN_TOKEN || undefined);
  for (const [i, s] of result.steps.entries()) {
    const verdict = s.accepted === undefined ? '' : s.accepted ? 'ACCEPTED' : 'REJECTED';
    console.log(`\n${s.ok ? '✔' : '✘'} ${i}. ${s.title}  ${verdict}${s.replayed ? ' (replayed)' : ''}`);
    console.log(`    ${s.detail}`);
    if (s.reason) console.log(`    why:      ${s.reason}`);
    if (s.balances) console.log(`    balances: ${s.balances}`);
  }
  console.log(`\n${result.passed ? 'All steps behaved as expected.' : 'Some steps deviated from the expectation!'}`);
  process.exit(result.passed ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
