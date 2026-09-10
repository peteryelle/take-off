-- tr_room_devices — one row per device (rack, CP, DC, RE, camera...) detected
-- or manually added on an enlarged-TR-room drawing (T-401 series). Feeds the
-- confidence-map-style ADD/REMOVE UI and the rack_count (etc.) rollups on
-- tr_schedule_rows.
--
-- page_id here is the ENLARGED-ROOM DRAWING page (e.g. T-401), not the
-- T-500 schedule page tr_schedule_rows.page_id points to -- a room's devices
-- live on a different sheet than its schedule row. tr_number is matched back
-- to tr_schedule_rows.tr_number via normalize-tr-name.js's staged matching
-- (exact -> punctuation-stripped -> suffix-dropped), not a hard FK, since the
-- same physical room is spelled inconsistently across sheets in this same
-- drawing set (confirmed: B050C-1 vs B050C1, EB51A-1 vs EB51A).
--
-- coded_note_number/coded_note_text are snapshotted verbatim from
-- parse-coded-notes.js at the time a device was added, not looked up live --
-- coded-note numbering is sheet-local and isn't a stable convention across
-- sheets, so a device's own snapshot stays meaningful even if the same sheet
-- gets re-parsed differently later.

CREATE TABLE IF NOT EXISTS public.tr_room_devices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id),
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tr_number text NOT NULL,

  coded_note_number integer,
  coded_note_text text,
  -- Rollup category, independent of the sheet-local coded-note number --
  -- e.g. 'rack_new' for T-401's note 2, 'rack_existing' for notes 9/11/12.
  -- Nullable until the categorization pass (next piece of this feature)
  -- fills it in; rack_count etc. on tr_schedule_rows reads THIS column, not
  -- coded_note_number, since two different sheets' "note 2" won't
  -- necessarily mean the same thing.
  category text,

  x_norm double precision NOT NULL,
  y_norm double precision NOT NULL,
  confidence text CHECK (confidence IN ('high','medium','low')),
  source text NOT NULL CHECK (source IN ('vision','manual')),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tr_room_devices_project_tr ON tr_room_devices(project_id, tr_number);
CREATE INDEX IF NOT EXISTS idx_tr_room_devices_page ON tr_room_devices(page_id);

ALTER TABLE tr_room_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON tr_room_devices;
CREATE POLICY org_isolation ON tr_room_devices
  FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());
