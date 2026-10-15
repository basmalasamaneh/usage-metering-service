# Design notes

## 1. Data model (`service/migrations/001_init.sql`)

```
plans(id PK, scope 'account'|'user', account_id NULL=predefined, name, monthly_allowance NULL=unlimited, max_units_per_request NULL=unlimited)
accounts(id uuid PK, name, api_key_hash UNIQUE, api_key_prefix, plan_id + plan_scope='account')   FK (plan_id, plan_scope) -> plans(id, scope)
users(id bigint PK, account_id, external_id, plan_id + plan_scope='user')   UNIQUE (account_id, external_id)
account_usage(account_id, period date, consumed, monthly_allowance)   PK (account_id, period)    one row per account and UTC month
user_usage(user_id, period date, consumed, monthly_allowance)         PK (user_id, period)
consume_requests(id identity, account_id, request_id, user_id, units, accepted, period, reason, violations, snapshot, decided_at, idem_key UNIQUE)
```

Decisions:

* **Counters are separate from plans.** `account_usage` / `user_usage` belong to the owner and the month, never to a plan.
  That is what makes "switching plans preserves consumed units" and "a new month starts at zero" fall out for free, and
  why plan edits cannot corrupt accounting.
* **Each counter row also records the allowance in force at its last accepted request** (`monthly_allowance`, written by the
  same upsert, no extra statement, no measurable cost). It is what lets a *closed* month keep a meaningful "remaining"
  after the plan has since changed, without storing per-month plan versions.
* **Plans are rows read at decision time**, never cached or compiled into code. "Changes take effect without redeploying"
  is therefore the default behaviour, not a feature.
* **Composite foreign keys** `(plan_id, plan_scope) -> plans(id, scope)` with a constant `plan_scope` per table make it
  impossible for the database to hold a user plan on an account (and vice versa), whatever the application does.
* **`consume_requests` is an append-only decision log and the idempotency table in one.** `snapshot` stores the plans, limits and
  balances in force when the decision was made, so history never changes when plans do. `idem_key` is a generated
  `account_id || ':' || request_id` with a single-column unique index (see PERFORMANCE.md, finding 3, for why it is not
  `UNIQUE (account_id, request_id)`).
* **Months are `date` values holding the first day of the UTC month** (CHECK constraint). No time-zone arithmetic in queries.
* **Counter tables use `fillfactor = 70`** so the constant updates of tiny hot rows stay HOT (no index maintenance, less bloat).
* **API keys:** 256-bit random keys, only the SHA-256 is stored (a slow hash would protect nothing for high-entropy keys),
  plus a short prefix for support. Lookups are by hash, so there is no string comparison to time.
* `bigint` counters are read as JS numbers; inputs are capped at 10^12 so every sum stays far below 2^53.

## 2. The consume path

`POST /v1/consume` -> `ConsumeCoordinator.submit(accountId, input)` -> `consumeBatch()` in `accounting/consume.ts`.

```
HTTP request
  |  onRequest hook: X-API-Key -> sha256 -> (cache | SELECT accounts) -> req.accountId       http/auth.ts
  |  zod validation (units: positive safe integer, ids: charset/length)                       http/schemas.ts
  v
ConsumeCoordinator (per account queue, in memory)                                             accounting/coordinator.ts
  |  at most one transaction in flight per account in this process; whatever queued meanwhile
  |  forms the next batch (up to BATCH_MAX). A lone request is a batch of one, no added delay.
  v
consumeBatch(accountId, jobs[]) - ONE database transaction                                    accounting/consume.ts
  1. BEGIN; SELECT 1 FROM accounts WHERE id=$account FOR NO KEY UPDATE      <- the per-account mutex
  2. one SELECT (fresh snapshot, taken after the lock) returning:
        account plan + month counter, the batch's users with plan + month counter,
        any requestIds of the batch that were already decided
  3. for each job, in order, in memory (domain/rules.ts):
        known requestId  -> replay the stored decision (or idempotency_conflict if user/units differ)
        unknown user     -> user_not_found (not recorded)
        else             -> evaluate(units, userLevel, accountLevel); if accepted bump the running totals
  4. one statement: INSERT decisions (ON CONFLICT DO NOTHING), upsert account_usage += total,
     upsert user_usage += per-user totals; a runtime-dependent division by zero aborts the
     transaction if not every decision row was new (cannot happen under the lock: a safety net)
     ; COMMIT
```

**Why it is correct**

* *No lost updates, no over-spend:* every writer of the counters of an account holds the account lock first, and reads the
  counters *after* acquiring it (step 2 is a separate statement so its snapshot is taken after the lock was granted; a
  single statement would use a snapshot taken before the lock wait and could be stale).
* *Both levels commit together or not at all:* one transaction. A rejection writes only the log row.
* *Idempotency is also serialised by the lock,* so two concurrent copies of one request cannot both be "new". The
  `idem_key` unique index is the last line of defence, backed by the in-statement check.
* *Plan changes linearise cleanly:* a request that *starts after* a plan update returned reads the new plan; a request already
  in flight may use the old one, as if it had been decided just before the update.
* *Several service instances* are safe for the same reason: the lock is in PostgreSQL. The in-process queue only decides
  *who waits where*. The test suite runs three app instances against one database.
* *No deadlocks:* a consume transaction takes exactly one lock (the account row) and the rows it then updates
  (`account_usage`, `user_usage`) are only ever written by transactions holding that lock. `FOR NO KEY UPDATE` does
  not conflict with the `KEY SHARE` locks of foreign-key checks, so registering users is never blocked by consumption.
* *A failed batch is retried request by request,* so one bad request or a transient error cannot fail its neighbours.
  The failed transaction rolled back completely, so nothing was counted. Clients may always retry with the same `requestId`.

**Alternatives considered**

| Option | Why not |
|---|---|
| `SERIALIZABLE` / `REPEATABLE READ` + retry on conflict | Under contention most transactions abort and retry: wasted work on exactly the hot case, plus retry logic everywhere. |
| Two atomic conditional `UPDATE ... WHERE consumed + n <= allowance` | Fine for one counter; making **two** counters all-or-nothing needs a lock or compensation anyway, and it cannot explain *which* rule failed. |
| Advisory lock per account | Equivalent, but the row lock needs no extra concept, and it also interlocks with plan assignment of the account. |
| Redis / in-memory counters | Adds a second source of truth that must survive restarts and stay consistent with the history. Out of the brief's scope ("one service and one database are enough"). |
| Pre-reserving ("leases") units per instance | Highest throughput for a hot account but gives up exactness at the boundary. Mentioned as a limitation, not built. |

## 3. Request lifecycle of the other endpoints

Reads (`/v1/users/:id/usage`, `/v1/usage`, `/v1/requests`) take no locks. The per-user view uses one SQL statement, so
user and account numbers come from one consistent snapshot. `remaining = max(0, allowance - consumed)`; `null` when unlimited. For the current month the allowance is the plan's current one;
for a closed month it is the one recorded with that month's counter. Pagination is keyset-based (opaque cursor = last numeric key), stable while rows are being added.

## 4. Extending the rules

Add a rule (for example `daily_allowance`):
1. a nullable column on `plans` (migration), exposed in `planView` and the create/update schemas;
2. a `Rule` object in `domain/rules.ts` (`check(levelState, units) -> Violation | null`) and an entry in `RULES`;
3. if it needs a counter (like a daily window), a counter table keyed by `(owner, period)` and one more upsert in the
   write statement; rules without state (min/max request size, allow-lists) need no storage at all.

The accounting transaction, API and idempotency code do not change. Interaction with the existing rules is by
construction: a request must satisfy **every** rule at **both** levels, and `violations` lists every rule that failed.
No additional rule was added to the delivered service on purpose: a correct, well-tested core was worth more than extras
(each extra counter also adds a write to the hottest path).

## 5. Things I would do next (in this order)

1. API-key rotation/revocation (`api_keys` table, cache invalidation).
2. Cross-account batching for many low-traffic accounts (lock several account rows in id order, one write).
3. Keep a per-month history of plan changes (today only the allowance at the month's last accepted request is kept).
4. Metrics endpoint in Prometheus format (batch size, lock wait, decision counts by reason).
5. Partition `consume_requests` by month if history grows into the hundreds of millions of rows.
