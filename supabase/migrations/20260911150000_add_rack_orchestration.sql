-- Rack orchestration — schema for wiring tr_schedule_rows + tr_room_devices +
-- (eventually) fiber-feed plant type into per-TR rack sizing.
--
-- Three pieces:
--   1. Bug fix: tr_room_devices.source CHECK never included 'leader_fan',
--      the value pass-tr-room-rack-count.js has been writing since that pass
--      replaced the vision-based one. Every leader-fan insert has been
--      violating this constraint. 'vision' is kept for any legacy/manual
--      vision-sourced rows; 'leader_fan' is added, not substituted for it.
--   2. tr_room_status — one row per (project, tr_number): has a room's
--      device set been human-reviewed via the confidence-map UI? A scan
--      that ran but wasn't confirmed and an unscanned room produce the same
--      device rows either way (empty or partial); the ONLY way to tell them
--      apart is this explicit status, which is why it's a separate table
--      rather than a flag inferred from tr_room_devices existing.
--   3. project_fiber_config — plant type (ISP/OSP) and strand basis for the
--      whole project, one row per project. Confirmed to be the SAME across
--      every TR on a job (Peter, chat) — this is deliberately NOT scoped to
--      tr_number the way tr_room_status is.
--   4. tr_rack_sizing — the orchestration's actual output: rack count
--      (from tr_room_devices, category='rack_new', only once tr_room_status
--      is 'confirmed') plus rack-assembly-rules.js's computed distribution.
--      A separate table, not columns bolted onto tr_schedule_rows, because
--      this is fully derived/recomputable — same reasoning as keeping
--      tr_room_devices separate from tr_schedule_rows: recomputing on rerun
--      should never require touching the schedule's own source-of-truth row.

ALTER TABLE tr_room_devices DROP CONSTRAINT IF EXISTS tr_room_devices_source_check;
ALTER TABLE tr_room_devices ADD CONSTRAINT tr_room_devices_source_check
  CHECK (source IN ('vision', 'leader_fan', 'manual'));

CREATE TABLE IF NOT EXISTS public.tr_room_status (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id),
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tr_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('scanned', 'confirmed')),
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tr_number)
);
CREATE INDEX IF NOT EXISTS idx_tr_room_status_project ON tr_room_status(project_id);

ALTER TABLE tr_room_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tr_room_status;
CREATE POLICY org_isolation ON tr_room_status
  FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

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
