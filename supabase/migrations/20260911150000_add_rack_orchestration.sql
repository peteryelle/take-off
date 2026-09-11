-- Rack orchestration — schema for wiring tr_schedule_rows.rack_count
-- (already written by tr-room-review.html's Save button) and the fiber-feed
-- plant type into per-TR rack sizing.
--
-- No confirmation table here. tr_schedule_rows.rack_count already IS the
-- confirmation signal -- null means unconfirmed, a number (including 0)
-- means a human reviewed the confidence map and saved it. A separate
-- confirmed/scanned status table was drafted for this migration and
-- dropped once that existing column and button were found -- it would
-- have given the app two sources of truth for the same fact.
--
-- Two pieces:
--   1. project_fiber_config — plant type (ISP/OSP) for the whole project,
--      one row per project. Confirmed (Peter, chat) to be the SAME across
--      every TR on a job — deliberately NOT scoped to tr_number.
--   2. tr_rack_sizing — the orchestration's derived output only (patch
--      panel distribution, sidecar count, fiber cassette count). rack_count
--      itself is NOT duplicated as an input source here; it's carried on
--      each row purely as a record of what count this sizing was computed
--      against, read back from tr_schedule_rows.rack_count at compute time.

CREATE TABLE IF NOT EXISTS public.project_fiber_config (
  project_id bigint PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  org_id bigint NOT NULL REFERENCES organizations(id),
  plant_type text CHECK (plant_type IN ('ISP', 'OSP')),
  source_page_id bigint REFERENCES pages(id),
  parsed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE project_fiber_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON project_fiber_config;
CREATE POLICY org_isolation ON project_fiber_config
  FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

CREATE TABLE IF NOT EXISTS public.tr_rack_sizing (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id),
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tr_number text NOT NULL,
  rack_count integer NOT NULL,
  patch_panel_distribution jsonb NOT NULL,
  sidecar_count integer NOT NULL,
  fiber_cassette_count integer,
  fiber_pending boolean NOT NULL DEFAULT true,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tr_number)
);
CREATE INDEX IF NOT EXISTS idx_tr_rack_sizing_project ON tr_rack_sizing(project_id);

ALTER TABLE tr_rack_sizing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tr_rack_sizing;
CREATE POLICY org_isolation ON tr_rack_sizing
  FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());
