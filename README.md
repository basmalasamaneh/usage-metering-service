# Usage Metering and Quota Service

A backend service that other applications call to **track usage and decide whether a user may perform an action**.
An account (the calling company) has a shared monthly allowance; each of its users has an individual one. Before
doing the work, the application asks the service to *consume units* for a user. The service checks **both** plans,
records the decision, and counts the units only if the whole amount is accepted.

TypeScript, Fastify, PostgreSQL. One service + one database. Includes a working example application ("Pagewise", a
document processing app), automated tests, a load-test harness with results, and a Docker Compose stack.

```
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:8080 | **Example application** (web page): allowances, "process a document", plan editor, decision history, guided demo |
| http://localhost:3000 | **Quota service API** (`/health`, `/v1/...`) |

Contents: [Quick start](#quick-start) · [Concepts](#concepts) · [How plans are applied](#how-plans-are-applied) ·
[API](#api) · [Plan changes](#plan-changes) · [Retries and idempotency](#retries-and-idempotency) ·
[Concurrency and performance](#concurrency-and-performance) · [Main design decisions](#main-design-decisions) · [Example client](#example-client) · [Tests](#tests) ·
[Product assumptions](#product-assumptions) · [Known limitations](#known-limitations) · [Code map](#code-map)

More: [docs/DESIGN.md](docs/DESIGN.md) (schema, request trace, trade-offs) ·
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) (load-test method, results, lessons).

---

## Quick start

Requirements: Docker with Compose v2. Nothing else.

```bash
docker compose up --build        # postgres + service + example client; migrations and predefined plans run on startup
```

Then open http://localhost:8080 and try, in this order:

1. Pick `alice`, enter **25** pages, *Process document*. → **Declined** by alice's per-request limit (20).
2. Enter **10**. → **Accepted**; both her meter and the shared account meter move.
3. *Send the last request again*. → the same decision, stamped **REPLAY**, nothing counted twice.
4. Change alice's plan in the dropdown, or edit a plan's limits under *Plans and limits*, and repeat. No redeploy, no client change.
5. *Run guided demo* shows the full story step by step (also: `docker compose exec client node dist/cli.js`).

Other commands:

```bash
docker compose --profile test run --rm tests            # automated tests against the compose PostgreSQL
docker compose --profile loadtest run --rm loadtest     # load + correctness test, results in loadtest/results/
docker compose down -v                                   # stop and delete all data
```

Configuration (all optional, env vars or a `.env` file, see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_TOKEN` | empty | If set, `POST /v1/accounts` and `GET /stats` require header `X-Admin-Token`. Empty = open (convenient for evaluation; the service logs a warning at startup). |
| `BATCH_MAX` | 64 | Max queued consume requests of one account decided in one transaction. `1` disables batching. |
| `DB_POOL_MAX` | 20 | PostgreSQL connections per service instance. |
| `DB_SYNCHRONOUS_COMMIT` | `on` | `off` trades durability of the last ~ms for ~10-20% throughput. Keep `on`. |
| `LOG_LEVEL` | `info` | pino level. |

Running without Docker: `cd service && npm ci && npm run build && DATABASE_URL=postgres://... node dist/index.js`
(Node >= 20, PostgreSQL >= 13). The service waits for the database and migrates on startup.

---

## Concepts

| Concept | Meaning |
|---|---|
| **Account** | The calling application/company. Has an *account plan* (limits shared by all its users) and an API key. |
| **User** | A user of that application, registered under an account, identified by **the application's own id** (`userId`, e.g. `"alice"` or an email). Has a *user plan*. |
| **Plan** | A named set of rules: `monthlyAllowance` and `maxUnitsPerRequest` (each may be `null` = unlimited). Has a scope: `account` or `user`. |
| **Units** | The one resource being metered (document-processing credits). Positive whole numbers. |

**Predefined plans** (seeded by migration `002`, read-only, visible to every account):

| id | scope | monthly allowance | per request |
|---|---|---|---|
| `starter` (default for new accounts) | account | 10,000 | 100 |
| `pro` | account | 1,000,000 | 1,000 |
| `basic` (default for new users) | user | 500 | 20 |
| `premium` | user | 5,000 | 200 |

**Custom plans** are created per account via the API; several users can share one definition and still keep separate usage.

### API keys

`POST /v1/accounts` returns the key **once** (`apiKey`, format `qk_...`). Only its SHA-256 is stored. Send it in every
other call as `X-API-Key: <key>`. The key identifies the calling account and grants access **only to that account's data**:
missing/unknown key -> `401`; a user, plan or request belonging to another account is reported as `404` (existence is never
leaked). Every query is scoped by the account id resolved from the key.

---

## How plans are applied

The **account plan and the user plan apply together**. A request is accepted only if *every* rule at *both* levels allows it.

| Rule | Account plan | User plan |
|---|---|---|
| `max_units_per_request` | largest single request | largest single request |
| `monthly_allowance` | shared by all users of the account, per UTC month | this user's own, per UTC month |

Example (the one from the brief): account 10,000/month & 100/request, user 1,000/month & 20/request.
Request 25 -> rejected by the **user** per-request limit even though both monthly allowances suffice. Request 10 -> accepted:
+10 on the user *and* +10 on the account. If the account has 5 units left, a 10-unit request is rejected by the **account**
even if the user has plenty. A rejection consumes **nothing**; there is no partial acceptance.

* Account usage is the sum of accepted usage of its users. Users sharing a plan do **not** share allowance.
* A bigger user allowance never increases the account's shared allowance.
* Usage belongs to the **UTC calendar month in which the request is processed**. A new month starts at zero at both levels;
  previous months stay queryable.
* When several rules are violated, the response lists all of them (`violations`) and names one `reason`. Precedence:
  per-request limits before monthly allowances (such a request can never succeed), and **user before account** inside each.
* Rules are pure functions in `service/src/domain/rules.ts`. Adding a rule = one column on `plans` + one entry in the `RULES` list.

---

## API

All bodies are JSON. Errors have one shape: `{"error": {"code": "...", "message": "...", "details": ...}}`.
Base URL `http://localhost:3000`. Everything except `/health`, `/stats` and `POST /v1/accounts` needs `X-API-Key` (`/stats` and account creation take the optional `X-Admin-Token` instead).

| Method & path | Purpose |
|---|---|
| `POST /v1/accounts` | Create an account `{name, planId?}` -> `201 {account, apiKey}` (`planId` must be a predefined account plan, default `starter`) |
| `GET /v1/account` | The calling account and its current plan |
| `PUT /v1/account/plan` | `{planId}` assign an account plan (predefined or own) |
| `GET /v1/plans?scope=account\|user` | Predefined plans + the account's own |
| `POST /v1/plans` | Create custom plan `{scope, name, monthlyAllowance?, maxUnitsPerRequest?}` (omitted/`null` = unlimited) |
| `GET /v1/plans/:id` | One plan |
| `PATCH /v1/plans/:id` | Update own plan (`name`, `monthlyAllowance`, `maxUnitsPerRequest`). Predefined -> `403 plan_read_only`. Effective for the next request. |
| `DELETE /v1/plans/:id` | Delete own plan; `409 plan_in_use` while assigned |
| `POST /v1/users` | Register `{userId, planId?}` (default `basic`) -> `201`; `409 user_exists` |
| `GET /v1/users?limit&cursor` | List users (paginated) |
| `GET /v1/users/:userId` | One user and their plan |
| `PUT /v1/users/:userId/plan` | `{planId}` assign a user plan |
| **`POST /v1/consume`** | **`{userId, units, requestId}`** -> the decision (below) |
| `GET /v1/users/:userId/usage?month=YYYY-MM` | Consumed/remaining at **both** levels (any month), the plans and limits applied to each, and `maxAcceptableUnits` (largest request accepted right now, current month only) |
| `GET /v1/usage?month&limit&cursor` | Account usage + usage of every registered user for a month |
| `GET /v1/usage/months?limit` | Months in which the account consumed anything |
| `GET /v1/requests?userId&month&outcome=accepted\|rejected&limit&cursor` | Request history, newest first, cursor-paginated |
| `GET /v1/requests/:requestId` | One recorded decision |
| `GET /health` | Liveness + database check |
| `GET /stats` | Batch sizes and pool usage (used by the load tests). Needs `X-Admin-Token` when `ADMIN_TOKEN` is set. |

Status codes: `200` decisions (accepted **and** rejected, see below), `201` created, `204` deleted, `400 validation_error`,
`401 missing_api_key | invalid_api_key | invalid_admin_token`, `403 plan_read_only`, `404 not_found | user_not_found | plan_not_found`,
`409 idempotency_conflict | user_exists | plan_name_taken | plan_in_use`, `422 plan_scope_mismatch | plan_not_found` (account creation).

### Walkthrough

```bash
# 1. create an account (the key is shown once)
curl -s -XPOST localhost:3000/v1/accounts -H 'content-type: application/json' -d '{"name":"Acme Docs"}'
#  -> {"account":{"id":"178e9305-...","name":"Acme Docs","plan":{"id":"starter",...}},"apiKey":"qk_...","notice":"Store this API key now..."}
export KEY=qk_...      # use the returned key
H=(-H "x-api-key: $KEY" -H 'content-type: application/json')

# 2. a custom user plan and a user on it
curl -s -XPOST localhost:3000/v1/plans "${H[@]}" -d '{"scope":"user","name":"Light","monthlyAllowance":30,"maxUnitsPerRequest":10}'
curl -s -XPOST localhost:3000/v1/users "${H[@]}" -d '{"userId":"alice","planId":"plan_..."}'

# 3. consume
curl -s -XPOST localhost:3000/v1/consume "${H[@]}" -d '{"userId":"alice","units":15,"requestId":"doc-1"}'
curl -s -XPOST localhost:3000/v1/consume "${H[@]}" -d '{"userId":"alice","units":8,"requestId":"doc-2"}'
```

A **rejection** (HTTP 200, `accepted: false`) names the rule and the level that stopped it; `account` and `user` show the
plan, limits and balances as of the decision:

```json
{
  "requestId": "doc-1", "userId": "alice", "units": 15, "accepted": false, "month": "2026-10",
  "reason": {
    "level": "user", "rule": "max_units_per_request", "limit": 10, "requested": 15,
    "message": "Requested 15 units exceeds the user plan \"Light\" limit of 10 units per request."
  },
  "violations": [ { "level": "user", "rule": "max_units_per_request", "...": "same as reason" } ],
  "account": { "planId": "starter", "planName": "Starter", "monthlyAllowance": 10000, "maxUnitsPerRequest": 100, "consumed": 0, "remaining": 10000 },
  "user":    { "planId": "plan_fe4f...", "planName": "Light", "monthlyAllowance": 30, "maxUnitsPerRequest": 10, "consumed": 0, "remaining": 30 },
  "decidedAt": "2026-10-13T21:39:33.024Z", "replayed": false
}
```

An **acceptance** has `"accepted": true, "reason": null, "violations": []` and the balances *after* counting
(`user.consumed: 8, remaining: 22`; `account.consumed: 8, remaining: 9992`). A monthly rejection additionally carries
`consumed` and `remaining` in the `reason`. `remaining` is `null` when the plan is unlimited.

`GET /v1/users/alice/usage` (inspect what applies right now):

```json
{ "userId": "alice", "month": "2026-10", "isCurrentMonth": true,
  "user":    { "plan": {"id": "plan_fe4f...", "name": "Light", "monthlyAllowance": 30, "maxUnitsPerRequest": 10},
               "consumed": 8, "monthlyAllowance": 30, "remaining": 22, "allowanceSource": "current_plan" },
  "account": { "plan": {"id": "starter", "name": "Starter", "monthlyAllowance": 10000, "maxUnitsPerRequest": 100},
               "consumed": 8, "monthlyAllowance": 10000, "remaining": 9992, "allowanceSource": "current_plan" },
  "maxAcceptableUnits": 10 }
```

`remaining = max(0, monthlyAllowance - consumed)`; `null` when the allowance is unlimited.

**Previous months** (`?month=2026-09`) also return consumed **and remaining**. Each month's counter records the allowance in
force at its last accepted request, so a closed month keeps showing what it looked like even after the plan was changed
(`allowanceSource: "recorded_at_last_request"`). A month in which nothing was consumed has no counter; it is reported as 0
used against the plan currently assigned (`allowanceSource: "current_plan"`). `plan` is always the plan *currently*
assigned. `maxAcceptableUnits` is `null` for closed months (it only makes sense "right now").

**Why HTTP 200 for a rejection?** Rejecting is a correct evaluation, not a failure of the call, and it makes a retry
return the identical status and body. Callers branch on `accepted`.

---

## Plan changes

* A plan update (`PATCH /v1/plans/:id`, `PUT .../plan`) is visible to the **very next** consume request: plans are read
  inside the decision transaction, never cached. Updating a shared custom plan affects every account/user assigned to it.
* **Switching plans preserves consumed units** (counters belong to the user/account and month, not to the plan). It never
  grants a fresh allowance.
* If an allowance is **lowered below existing usage**: `remaining` is `0` (never negative) and further consumption is rejected at
  that level (`monthly_allowance`, `remaining: 0`) until the allowance exceeds usage again.
* **History is preserved.** Every decision stores a snapshot of the plans, limits and balances in force when it was made, so
  later edits never rewrite the past (tested).

## Retries and idempotency

`requestId` (unique **per account**, 1-128 chars `A-Za-z0-9_.:@+-`) makes retries safe:

* Same `requestId` + same `userId` + same `units` -> the **original decision** again, `replayed: true`, nothing counted twice. This
  includes rejections, and also holds after plans changed or a new month began: a retry is *not* re-evaluated. To try again after a
  rejection, use a new `requestId`.
* Same `requestId` with a different user or units -> `409 idempotency_conflict`, nothing counted.
* Concurrent duplicates (a retry storm) are counted exactly once (tested with 40 parallel copies and in the load test).
* A `500`/timeout may be retried with the same `requestId`: a failed transaction rolls back completely.
* Not recorded (so they never occupy a `requestId`): `400` validation errors and `404` unknown users.

---

## Concurrency and performance

Correctness comes from PostgreSQL, not from the application: every consume locks the **account row**
(`SELECT ... FOR NO KEY UPDATE`), then reads plans, counters and history in a fresh snapshot, decides, writes the decisions
and increments **both** counters in one statement, and commits. One lock therefore serialises the account counter, all user
counters of the account and the idempotency check, also across several service instances; there is no deadlock-prone lock
ordering because only one row is ever locked.

On top of that, a small **per-account group commit** (`accounting/coordinator.ts`) decides requests that queued up while a
transaction was running in the *same* transaction. It never delays a lone request, and never changes a decision.

Measured on a deliberately small machine (1 vCPU shared by load generator, service and PostgreSQL): **~11x** on one hot account from batching (237 -> 2,628 req/s in the final back-to-back measurement), plus +35% from a query-plan fix found by profiling, with all invariants verified after each run (no over-spend,
every rejection justified, idempotency exact, consistent while plans change). Method, results, what did *not* help, and
the remaining weak spot are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Reproduce with
`docker compose --profile loadtest run --rm loadtest`.

---

## Main design decisions

Full reasoning, alternatives and a request trace are in [docs/DESIGN.md](docs/DESIGN.md). The short version:

1. **PostgreSQL is the single source of truth, and one row lock is the whole concurrency story.** Every consume locks the account row, then reads, decides and writes in one transaction. This makes the account counter, every user counter and the idempotency check exact, also across several service instances, with no deadlock-prone lock ordering. Rejected alternatives: SERIALIZABLE with retries (aborts pile up on exactly the hot case), Redis counters (a second source of truth), per-instance unit leases (not exact at the boundary).
2. **Counters are separate from plans.** Usage belongs to (owner, UTC month), never to a plan. That is why switching plans keeps usage, a new month starts at zero, and plan edits cannot corrupt accounting. Plans are read at decision time and never cached, so changes apply to the next request without a redeploy.
3. **Rules are pure functions** (`domain/rules.ts`) evaluated in memory over a snapshot; accounting, rules and HTTP handling are separate layers. A request must satisfy every rule at both levels, and all violated rules are reported.
4. **Every decision is stored with a snapshot** of the plans, limits and balances in force, in an append-only log that doubles as the idempotency table. History never changes when plans do.
5. **Per-account group commit** decides requests that queued up during a transaction in the next one. It is an optimisation only: a lone request is never delayed and decisions are identical (the concurrency tests run with it on and off).
6. **Integrity is enforced in the schema too:** composite foreign keys keep account plans on accounts and user plans on users; CHECK constraints keep months and counters valid; the idempotency key is a single-column unique index chosen after profiling showed the planner mis-planning the two-column form.
7. **Scope kept deliberately small:** no extra rule types, no key rotation, no rate limiting. A correct, well-tested core with documented limits over unfinished extras.

## Example client

`client/` is "Pagewise", a small document-processing app. Its backend holds the account's API key and calls the service for
its users; the browser never sees the key. On first start it creates a demo account **through the public API** (a "Team"
account plan, two user plans, users `alice`, `carol` and `bob`), and keeps the key in a volume so restarts reuse it.

* **Web page** (http://localhost:8080): per-user and shared meters, process a document, send the last request again,
  switch a user's plan, edit plan limits, recent decisions, guided demo. *Reset demo data* creates a fresh account.
* **Guided demo** (button, or `docker compose exec client node dist/cli.js`, or `npm run demo:dev` in `client/`): runs on a
  separate fresh account and shows, in order: users with **different plans** in one account; an **accepted** action; a rejection
  by a **user** limit; a rejection by the **shared account** limit although the user still has allowance; a **safe retry**;
  raising the account plan with `PATCH` and the same request now accepted; switching a user to another plan (consumed kept) so a
  previously rejected size passes; lowering the account allowance below usage (remaining 0, rejected). The client code is never
  changed, only plans in the service. Each step is asserted; the CLI exits non-zero if any step deviates.
* The only service-specific code in the client is `client/src/quotaClient.ts` (a thin HTTP wrapper).

## Tests

```bash
docker compose --profile test run --rm tests            # in Docker
# or natively, with any PostgreSQL:
cd service && npm ci && DATABASE_URL=postgres://user:pass@localhost:5432/db npm test
```

96 tests against a real PostgreSQL (each test file gets its own temporary schema, so nothing leaks between files and your
data is untouched):

| File | Covers |
|---|---|
| `auth-isolation` | missing/invalid keys on every endpoint, hashed key storage, admin token (also guarding `/stats`), path-id validation, **account isolation** (users, plans, usage, months, history, request ids, same user id in two accounts, no existence leaks) |
| `consume` | the brief's examples (25 -> user per-request; 10 -> both counters; 5 left -> account rejection), rejection consumes nothing, shared plans/separate usage, unlimited plans, input validation |
| `plans` | predefined seed & read-only, custom CRUD, scope enforcement, name uniqueness, in-use deletion, pagination |
| `plan-changes` | plan updates apply to the next request, switching preserves usage, allowance lowered below usage, history snapshots unchanged |
| `months` | UTC month boundaries (incl. year rollover), usage reset, past months queryable **with remaining** (kept after later plan changes), month filters, replay in a later month |
| `idempotency` | replay, replayed rejections, replay after plan change, conflicts, per-account scope, 40-way concurrent duplicates |
| `concurrency` | with batching off **and** on: never over-spend under 200 parallel requests, per-user limits, mixed sizes, independent accounts, plan churn during load, **several service instances on one database**, failure isolation inside a batch |
| `history-persistence` | cursor pagination and filters, restart with the same database |
| `rules` | pure rule evaluation and period maths |

After the concurrency tests an SQL invariant check asserts `account usage == sum(user usage) == sum(accepted units in the log)` per month.

---

## Product assumptions

The brief leaves these open. Each is a deliberate choice, applied consistently:

1. **Plan scope.** Every plan is either an `account` plan or a `user` plan and can only be assigned to that kind of owner (enforced in the API and by composite foreign keys). Prevents assigning a "user" plan to an account by mistake.
2. **`null` = unlimited.** Either rule of a custom plan may be omitted/`null`; `0` blocks everything.
3. **Defaults.** New accounts start on `starter`, new users on `basic`. Accounts can only *start* on a predefined plan (they have no custom plans yet).
4. **User identity.** Users are identified by the application's own string id, unique within an account.
5. **Account creation (and `/stats`) are open** unless `ADMIN_TOKEN` is set. The brief defines no operator role and asks that accounts can be created and keys issued, so the default keeps the stack frictionless for evaluation; the service logs a warning at startup when it is unset. Set the token in any shared environment.
6. **Rejection = HTTP 200** with `accepted: false` (see above). Malformed input is `400`, unknown user `404`; neither is recorded in history.
7. **Rule precedence for the reported `reason`:** per-request before monthly, user before account; all violations are also listed.
8. **Month boundary.** The month is decided by the service clock when the decision transaction runs. A request that waited for a lock across midnight UTC counts toward the month in which it was *processed*.
9. **A retry replays the stored decision**, even if plans or the month changed. It is never re-evaluated.
10. **"Remaining" for closed months** is computed against the allowance recorded with that month's counter at its last accepted request (not the current plan), so history does not change when plans do. Months with no usage are reported against the current plan.
11. **Units** must be positive integers <= 10^12; allowances <= 10^12.
12. **Deleting** a plan is allowed only when unassigned. Users and accounts are never deleted (history must stay intact).
13. **API keys** cannot be rotated or revoked in this version (listed under limitations).

## Known limitations

* **No API-key rotation/revocation** and no per-key scopes. Adding it needs a `api_keys` table; the in-memory key cache would need invalidation.
* **Account creation is unauthenticated by default** (see assumption 5; startup warning, `ADMIN_TOKEN` switch).
* **No rate limiting** of the API itself (units are metered, HTTP calls are not).
* **Throughput across many low-traffic accounts** is bounded by the fixed per-transaction cost (~400-600 req/s on the 1-vCPU test box). Cross-account batching is the identified next step (docs/PERFORMANCE.md).
* The allowance recorded for a closed month is the one in force at its **last accepted request**; an edit made later in that month without further consumption is not reflected.
* A hot account is limited by a single lock by design (a shared allowance is a single counter); sharding the counter into leases would raise it at the cost of strict exactness.
* Only monthly UTC periods; no other windows (daily, rolling) or resource types. Billing/payments/refunds/roles are out of scope per the brief.
- The Compose stack was verified on Windows with WSL2 and Docker Desktop: `docker compose up --build`, the web scenario, the CLI demo, the API/key/isolation checks, the test profile (96 passed), the load-test profile (all scenarios consistent), and a fresh start after `docker compose down -v`. Before that, the Dockerfiles had been validated by running their exact steps natively.

## Code map

```
service/
  migrations/001_init.sql            schema; 002 seeds the predefined plans
  src/domain/rules.ts                quota rules (pure) and precedence
  src/domain/period.ts               UTC month helpers, Clock
  src/accounting/consume.ts          THE decision transaction (lock -> read -> decide -> write)
  src/accounting/coordinator.ts      per-account group commit and failure isolation
  src/repo/*.ts                      SQL for plans, accounts, users, usage, request history
  src/http/                          auth, validation (zod), views, errors, routes/*
  src/app.ts, index.ts, config.ts    wiring, startup (wait for DB, migrate), env config
  test/                              96 tests (real PostgreSQL)
client/                              example app: backend (holds the key), web page, CLI demo
loadtest/                            load + correctness harness and committed results
docs/                                DESIGN.md, PERFORMANCE.md
docker-compose.yml                   postgres, service, client (+ `test` and `loadtest` profiles)
```
