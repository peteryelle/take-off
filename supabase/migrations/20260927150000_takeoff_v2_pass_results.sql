-- Take-Off v2 — Migration 9: stored metered-pass results for free reuse
-- A metered pass (Pass B, symbol detection) stores its parsed result keyed by
-- a SHA-256 of the exact image it was given plus a "variant" (prompt version,
-- model, and for symbols the device type's description). The same image again
-- — a re-run, a duplicate sheet, an unchanged revision — reuses the stored
-- result with no model call. Keyed on the image, not the page's text
-- fingerprint, because scanned pages have no text and would all collide.

CREATE TABLE takeoff.pass_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES public.organizations(id),
  pass        text   NOT NULL,              -- pass_b | symbol
  input_hash  text   NOT NULL,              -- sha256 of the image sent to the model
  variant     text   NOT NULL,              -- sha256 of prompt version + model (+ type description)
  result      jsonb  NOT NULL,
  first_page_id bigint REFERENCES takeoff.pages(id) ON DELETE SET NULL,
  hits        integer NOT NULL DEFAULT 0,   -- times reused for free
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, pass, input_hash, variant)
);

ALTER TABLE takeoff.pass_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.pass_results FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON takeoff.pass_results TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE takeoff.pass_results_id_seq TO authenticated, service_role;

-- confirm
SELECT relname, relrowsecurity FROM pg_class WHERE oid = 'takeoff.pass_results'::regclass;
