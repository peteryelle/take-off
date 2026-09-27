-- WF5 TR rooms (manual entry). Applied to production 2026-09-27 via MCP.
-- tr_room_devices: one row per (project, TR, column) so the grid can upsert.
-- tr_room_marks: the "done" stamp a user places on the room plan for each TR.

ALTER TABLE takeoff.tr_room_devices ALTER COLUMN tr_name SET NOT NULL;
ALTER TABLE takeoff.tr_room_devices
  ADD CONSTRAINT tr_room_devices_room_category_key UNIQUE (project_id, tr_name, category);

CREATE TABLE takeoff.tr_room_marks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES public.organizations(id),
  project_id  bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  tr_name     text   NOT NULL,
  page_id     bigint REFERENCES takeoff.pages(id) ON DELETE SET NULL,
  x_norm      double precision,
  y_norm      double precision,
  marked_by   uuid REFERENCES auth.users(id),
  marked_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tr_name)
);
CREATE INDEX idx_to_tr_room_marks_project ON takeoff.tr_room_marks(project_id);
ALTER TABLE takeoff.tr_room_marks ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.tr_room_marks FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
