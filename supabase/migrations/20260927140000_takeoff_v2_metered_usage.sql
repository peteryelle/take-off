-- Take-Off v2 — Migration 8: metered (LLM) usage log — owner-only
-- Metered passes just run (no cap, no prompt). Every model call is logged
-- with its token use and estimated cost, per page, so the owner can see what
-- each page and each pass costs. NOT visible to project users:
--   * RLS is enabled with NO policy for `authenticated`, so the Data API
--     returns nothing to any signed-in user;
--   * only the service role (the functions) reads/writes it, and the owner
--     endpoint /api/wf/wf4/usage checks the caller's email against the
--     TAKEOFF_OWNER_EMAILS environment variable before returning anything.

CREATE TABLE takeoff.metered_prices (
  model             text PRIMARY KEY,
  input_per_mtok    numeric NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok   numeric NOT NULL CHECK (output_per_mtok >= 0),
  note              text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- List price as recalled when this was written — confirm in the Anthropic console
-- and update this row if it differs (costs are recomputed from this table).
INSERT INTO takeoff.metered_prices (model, input_per_mtok, output_per_mtok, note)
VALUES ('claude-sonnet-4-5', 3.00, 15.00, 'Unconfirmed list price - verify in Anthropic console');

CREATE TABLE takeoff.metered_calls (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             bigint NOT NULL REFERENCES public.organizations(id),
  project_id         bigint REFERENCES takeoff.projects(id) ON DELETE SET NULL,
  page_id            bigint REFERENCES takeoff.pages(id) ON DELETE SET NULL,
  pass               text   NOT NULL,          -- pass_b | symbol | discover:<action>
  detail             text,                     -- e.g. device type name, strip index
  model              text   NOT NULL,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  cost_usd           numeric,                  -- at the price in metered_prices when logged
  duration_ms        integer,
  ok                 boolean NOT NULL DEFAULT true,
  error              text,
  called_by          uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_metered_calls_project ON takeoff.metered_calls(project_id, created_at);
CREATE INDEX idx_to_metered_calls_page    ON takeoff.metered_calls(page_id);

ALTER TABLE takeoff.metered_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE takeoff.metered_calls  ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: invisible to every signed-in user via the Data API.
REVOKE ALL ON takeoff.metered_prices, takeoff.metered_calls FROM authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON takeoff.metered_prices, takeoff.metered_calls TO service_role;
GRANT USAGE, SELECT ON SEQUENCE takeoff.metered_calls_id_seq TO service_role;

-- confirm
SELECT c.relname, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname='takeoff' AND p.tablename=c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='takeoff' AND c.relname IN ('metered_prices','metered_calls');
