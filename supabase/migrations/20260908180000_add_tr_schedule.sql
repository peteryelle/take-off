-- Add TR (telecom room) schedule support — for T-500-style "TR Termination
-- and Hardware Schedule" tables. Mirrors the existing pages.schedule jsonb
-- config (used by schedule.js for UIN-keyed device schedules), but this is a
-- DIFFERENT shape: one row per TR room, no UIN, no x/y, nothing to route.
-- Written by netlify/functions/pass-tr-schedule.js, read by public/lib/tr-schedule.js.

-- Per-page config, same convention as pages.schedule:
--   { present, locator, columns: { tr_number, terminations, patch_panels,
--     building?, level? } }
ALTER TABLE pages ADD COLUMN IF NOT EXISTS tr_schedule jsonb;

CREATE TABLE IF NOT EXISTS public.tr_schedule_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id),
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tr_number text NOT NULL,
  building text,
  level text,
  total_terminations integer NOT NULL,
  min_patch_panels integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, tr_number)
);
CREATE INDEX IF NOT EXISTS idx_tr_schedule_rows_project ON tr_schedule_rows(project_id);

ALTER TABLE tr_schedule_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON tr_schedule_rows;
CREATE POLICY org_isolation ON tr_schedule_rows
  FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());
