-- Predefined, read-only plans. Their definitions are versioned with the schema:
-- change them with a new migration, never through the API.
INSERT INTO plans (id, scope, account_id, name, monthly_allowance, max_units_per_request) VALUES
  ('starter', 'account', NULL, 'Starter',    10000,  100),
  ('pro',     'account', NULL, 'Pro',      1000000, 1000),
  ('basic',   'user',    NULL, 'Basic',        500,   20),
  ('premium', 'user',    NULL, 'Premium',     5000,  200)
ON CONFLICT (id) DO NOTHING;
