# Performance testing

Everything here was produced with the committed harness (`loadtest/`) against the committed service.
Raw results (JSON) are in `loadtest/results/` (`v1-*` first version, `v3-*` after the query-plan fix, `v4-*` the delivered code).

## Environment (read this before quoting any number)

| | |
|---|---|
| Machine | **1 vCPU**, 4 GB RAM, Linux container (a small sandbox, not a server) |
| Topology | load generator, Node service **and** PostgreSQL 16 all on that single core, talking over localhost |
| PostgreSQL | stock Ubuntu package config (`shared_buffers=128MB`, `fsync=on`, `synchronous_commit=on`) |
| Service | Node 22, `DB_POOL_MAX=20`, `LOG_LEVEL=warn` |
| Load | closed loop, **64 concurrent workers**, 8 s per scenario |
| Disk | `pg_test_fsync`: ~0.25 ms per fsync, i.e. fast |

Because three processes fight for one core, **absolute numbers are pessimistic and noisy**. The sandbox is also
shared: between two measurement sessions a few hours apart the *same code* ran about **2x slower** (hot account:
4,247 req/s in session 1, 2,089-2,628 in session 2; a controlled A/B-A/B run proved the code was not the cause, see
"What the numbers taught me", point 6). **Only numbers measured back to back are comparable**; the tables below are
grouped by session for that reason. The *relative* effects and the correctness checks are what matter. The load generator also
caps what can be shown for the fast scenarios. Docker was not available in the sandbox, so the numbers
come from running the compiled service natively (`node dist/index.js`) against a local PostgreSQL;
`docker compose --profile loadtest run --rm loadtest` runs the identical harness against the compose stack.

## What is tested

| Scenario | Shape | What it proves |
|---|---|---|
| `spread` | 20 accounts x 10 users, nothing is ever rejected | throughput when accounts do not contend |
| `hot` | **1 account**, 50 users, nothing rejected | worst case: every request serialises on one account |
| `exhaust` | 1 account, allowance 20,000, 15,000 requests of 1-5 units | **never over-spends**, every rejection was justified (`remaining < requested`), the allowance is used up exactly |
| `storm` | every request sent **3x concurrently** with the same `requestId` | idempotency: counted once, replays are exactly 2/3 of all responses |
| `churn` | hot account while its plan is PATCHed every ~20 ms | consistency while rules change under load |

After every scenario the harness compares what the service reports (`GET /v1/usage`, paginated user totals)
with what it observed in the responses. Any mismatch fails the run (exit code 1). **All runs below were consistent
with zero errors.** The automated test-suite additionally asserts, after every test, that
`account usage == sum(user usage) == sum(accepted units in the request log)` directly in SQL.

## Results (requests per second, 64 concurrent clients)

Session 1 (runs A-D were measured within one hour, so they are comparable with each other):

| Run | spread | hot | exhaust | storm | churn |
|---|---|---|---|---|---|
| A. first version, no batching (`BATCH_MAX=1`) | 297 | 270 | 269 | 114 | 260 |
| B. first version, batching (`BATCH_MAX=64`) | 572 | 3,122 | 3,490 | 1,427 | 3,823 |
| C. + query-plan fix, no batching | 372 | 363 | 391 | 148 | 357 |
| D. + query-plan fix, batching | 613 | 4,247 | 4,409 | 1,940 | 4,274 |

Session 2, **the delivered code** (E and F were measured back to back, in this order, on a fresh database each):

| Run | spread | hot | exhaust | storm | churn |
|---|---|---|---|---|---|
| E. final, no batching (`BATCH_MAX=1`) | 256 | 237 | 298 | 122 | 238 |
| F. final, batching (**default**) | 424 | 2,628 | 2,683 | 1,375 | 2,601 |

Within session 2, batching is worth **11x** on a hot account (237 -> 2,628), the same ratio as in session 1 (270 -> 3,122, ~12x).

Delivered code, batching on (run F, `loadtest/results/v4-batch64.json`):

| Scenario | req/s | p50 ms | p95 ms | p99 ms | avg batch size | consistency |
|---|---|---|---|---|---|---|
| spread | 424 | 139.4 | 234.6 | 380.5 | 1.95 | OK |
| hot | 2,628 | 21.7 | 39.2 | 69.9 | 31.8 | OK |
| exhaust | 2,683 | 21.8 | 34.7 | 43.9 | 31.7 | OK (accepted exactly 20,000 of 20,000) |
| storm | 1,375 | 44.8 | 65.2 | 73.9 | 35.5 | OK (33,186 HTTP requests = 11,062 logical + 22,124 replays) |
| churn | 2,601 | 22.2 | 37.3 | 52.6 | 31.8 | OK (256 plan edits during the run) |

Latencies are closed-loop: with 64 clients always waiting, latency is mostly queueing time (about
64 / throughput), not the cost of one request. Measured with a single client, one uncontended consume transaction
costs ~3.6 ms (see point 2).

## What the numbers taught me

**1. The bottleneck is serialisation on the account row, as designed.** Every accepted unit must update the
shared account counter, so all requests of one account are serialised by a row lock. Without batching a hot
account is limited to ~1 / (transaction time) = ~270-360 req/s here (runs A, C). This is inherent to a shared
allowance; the question is how cheaply one decision can be made.

**2. Per-account group commit gives ~11-12x on a hot account, with no correctness trade-off.** Requests that
queue up while a transaction runs are decided together in the next one (up to `BATCH_MAX`), in arrival order,
against running totals held in memory, written with one statement. Measured in isolation with every request
accepted (one client, no load generator): a transaction with 1 request takes ~3.6 ms, with 32 requests ~8.0 ms,
with 64 requests ~7.9 ms. So 32 requests cost ~8 ms instead of 32 x 3.6 = ~114 ms: a fixed cost of roughly 3.5 ms
per transaction and about 0.1 ms per additional request.
There is no artificial wait: with no contention a batch has one request and latency is unchanged.
The same invariants hold with batching on and off (the concurrency tests run both ways).

**3. A planner problem found by profiling, not by guessing.** `EXPLAIN (ANALYZE, BUFFERS)` of the "read the
context" query showed PostgreSQL scanning the account's *entire* request history to find one `requestId`
(4,760 rows, 1,170 buffers, 2.3 ms) because, while table statistics are missing/stale, it considered the
`(account_id, id)` index as good as the unique `(account_id, request_id)` index. Cost grew with history size.
Fix: a single-column generated unique key (`idem_key`) and a LATERAL probe for users. The lookup is now
~0.08 ms and independent of history size and of statistics. Effect (same session): +35% without batching (270 -> 363 req/s hot)
and +36% with batching (3,122 -> 4,247). I would not have found this by reading the code; it only shows with
fresh data, which is exactly what a load test creates.

**4. Things that did not help (and what I kept).**
- Fusing statements to cut round trips from 5 to 3 (`BEGIN`+lock, write+`COMMIT`) made **no measurable
  difference** here (hot 267 vs 270 req/s without batching) because a localhost round trip is only ~0.11 ms.
  I kept it: it is covered by tests, and it should matter when the database is a network hop away (each round
  trip then costs ~0.5-1 ms). It is the least proven change; if it ever hurts readability, drop it.
- `synchronous_commit=off` (`DB_SYNCHRONOUS_COMMIT=off`, session 1): hot 4,247 -> 4,762 req/s (+12%) with batching, ~+20%
  without. Modest, because group commit already amortises the flush, and it trades durability (a crash can
  lose the last few hundred ms of *acknowledged* decisions, so usage could be under-counted). **Left `on` by
  default**; it is a documented knob, not a recommendation.

**5. The remaining weak spot: many accounts, little contention (`spread`, ~400-600 req/s).** Batches there average
~2 requests, so almost every request pays the ~3.5 ms fixed transaction cost, on one shared core. The next step
would be *cross-account* batching (lock several account rows in id order, decide them all, one write), at the
price of more complex failure isolation: a slow lock on one account would delay unrelated accounts in the same
batch. I deliberately did not build it: the required behaviour is correct and the hot-account case, which is
the one correctness actually constrains, is fast. A multi-core machine with PostgreSQL on its own cores will
raise this number substantially because the three processes will no longer compete.

**6. A control experiment that saved me from a wrong conclusion.** After the last feature (recording the allowance in
force with each month's counters, two more columns written per decision) hot-account throughput looked like it had halved
(4,247 -> ~2,100 req/s). Instead of assuming the feature was to blame, I ran an alternating A/B/A/B comparison of the
final code against a copy with that write removed, on a fresh database each time:
new 2,058 / 2,222 vs old 2,005 / 2,137 req/s. No measurable cost: the whole machine had slowed down. That is why
absolute numbers from different sessions are not mixed above, and why I trust the *ratios* measured back to back.

## Reproducing

Prerequisites: Node >= 20 and a running PostgreSQL (or Docker).

```bash
# Option 1: docker compose (service + postgres already running via `docker compose up -d --build`)
docker compose --profile loadtest run --rm loadtest                       # all scenarios, results in loadtest/results/
docker compose --profile loadtest run --rm loadtest --scenario hot --duration 15 --concurrency 128 --url http://service:3000 --label mine

# Option 2: natively
cd service && npm ci && npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/quota LOG_LEVEL=warn BATCH_MAX=64 node dist/index.js &
cd ../loadtest && npm ci
npx tsx src/load.ts --scenario all --duration 8 --concurrency 64 --label d-batching
# compare with batching disabled: restart the service with BATCH_MAX=1 and use --label c-no-batching
```

Options: `--scenario spread,hot,exhaust,storm,churn|all`, `--duration <s>`, `--concurrency <n>`, `--url`, `--label`, `--out`.
The service exposes `GET /stats` (batches, average and maximum batch size, pool usage) which the harness reads
to report batch sizes.

## A run on the delivered Docker stack (`loadtest/results/compose.json`)

The full stack was also load-tested through `docker compose --profile loadtest run --rm loadtest`
on a Windows machine with WSL2 and Docker Desktop (64 clients, 10 s per scenario, defaults:
`BATCH_MAX=64`, `synchronous_commit=on`):

| spread | hot | exhaust | storm | churn |
|---|---|---|---|---|
| 136 | 423 | 616 | 237 | 541 |

Every scenario finished `consistent` with 0 errors, so the correctness checks (no over-spend, idempotency,
consistency while plans change) hold on this stack too. Throughput is lower than in the sections above,
which were measured on a different machine natively. The cause was not investigated (storage, CPU and the
Docker/WSL2 virtualisation layer all differ), so this run is evidence of correctness and of the compose
setup working end to end, not a like-for-like performance comparison.
