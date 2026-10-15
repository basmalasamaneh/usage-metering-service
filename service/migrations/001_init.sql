-- Schema for the usage metering service.
-- Design notes (see docs/DESIGN.md):
--  * plans.account_id IS NULL  => predefined, read-only plan shared by everybody.
--  * Composite FKs (plan_id, plan_scope) guarantee at DB level that an account can only
--    point at an 'account' plan and a user only at a 'user' plan.
--  * Counters live in account_usage / user_usage, one row per (owner, UTC month).
--  * consume_requests is the append-only decision log and the idempotency table.

CREATE TABLE plans (
  id                    text PRIMARY KEY,
  scope                 text NOT NULL CHECK (scope IN ('account', 'user')),
  account_id            uuid,
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  monthly_allowance     bigint CHECK (monthly_allowance IS NULL OR monthly_allowance >= 0),
  max_units_per_request bigint CHECK (max_units_per_request IS NULL OR max_units_per_request >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope)
);
CREATE UNIQUE INDEX plans_predefined_name_uq ON plans (scope, lower(name)) WHERE account_id IS NULL;
CREATE UNIQUE INDEX plans_custom_name_uq ON plans (account_id, scope, lower(name)) WHERE account_id IS NOT NULL;
CREATE INDEX plans_account_idx ON plans (account_id) WHERE account_id IS NOT NULL;

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  api_key_hash   bytea NOT NULL UNIQUE,          -- SHA-256 of the key; the key itself is never stored
  api_key_prefix text NOT NULL,                  -- first characters, to recognise a key in support/debugging
  plan_id        text NOT NULL,
  plan_scope     text NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);
CREATE INDEX accounts_plan_idx ON accounts (plan_id);

ALTER TABLE plans
  ADD CONSTRAINT plans_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id);

CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128),  -- the caller's own user identifier
  plan_id     text NOT NULL,
  plan_scope  text NOT NULL DEFAULT 'user' CHECK (plan_scope = 'user'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),
  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);
CREATE INDEX users_plan_idx ON users (plan_id);

-- Counters. Tiny, extremely hot rows: leave room in each page so updates stay HOT.
CREATE TABLE account_usage (
  account_id uuid   NOT NULL REFERENCES accounts (id),
  period     date   NOT NULL CHECK (extract(day FROM period) = 1),   -- first day of the UTC month
  consumed   bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  -- Allowance in force at the last accepted request of the month (NULL = unlimited). Lets a CLOSED month
  -- still report a meaningful "remaining" after the plan has since been changed.
  monthly_allowance bigint CHECK (monthly_allowance IS NULL OR monthly_allowance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period)
) WITH (fillfactor = 70);

CREATE TABLE user_usage (
  user_id    bigint NOT NULL REFERENCES users (id),
  period     date   NOT NULL CHECK (extract(day FROM period) = 1),
  consumed   bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  monthly_allowance bigint CHECK (monthly_allowance IS NULL OR monthly_allowance >= 0),  -- see account_usage
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
) WITH (fillfactor = 70);

CREATE TABLE consume_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid    NOT NULL REFERENCES accounts (id),
  request_id   text    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  user_id      bigint  NOT NULL REFERENCES users (id),
  units        bigint  NOT NULL CHECK (units > 0),
  accepted     boolean NOT NULL,
  period       date    NOT NULL,
  reason       jsonb,                              -- primary violated rule (NULL when accepted)
  violations   jsonb   NOT NULL DEFAULT '[]',      -- every violated rule, in precedence order
  snapshot     jsonb   NOT NULL,                   -- plans, limits and balances as of this decision
  decided_at   timestamptz NOT NULL,
  -- Idempotency key: one request id is decided once per account. It is a single generated column on
  -- purpose: a UNIQUE (account_id, request_id) index competes with the history index (account_id, id)
  -- and, while table statistics are missing or stale, the planner may then scan an account's whole
  -- history to find one request id. A one-column unique index leaves it no wrong choice.
  idem_key     text GENERATED ALWAYS AS (account_id::text || ':' || request_id) STORED,
  UNIQUE (idem_key)
);
CREATE INDEX consume_requests_account_idx ON consume_requests (account_id, id DESC);
CREATE INDEX consume_requests_user_idx ON consume_requests (user_id, id DESC);
