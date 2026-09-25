-- Take-Off v2 — WF3: one record per measured sheet, plus the engine's full row detail.
CREATE TABLE takeoff.osp_sheet_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint NOT NULL REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  sheet_number      text,
  is_overview       boolean NOT NULL DEFAULT false,
  scale_ft_per_in   numeric,
  limits            jsonb NOT NULL DEFAULT '{}'::jsonb,
  takeoff           jsonb NOT NULL DEFAULT '[]'::jsonb,
  problems          jsonb NOT NULL DEFAULT '[]'::jsonb,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_by            uuid REFERENCES auth.users(id),
  run_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id)
);
CREATE INDEX idx_to_osp_sheet_runs_project ON takeoff.osp_sheet_runs(project_id);

ALTER TABLE takeoff.osp_nodes         ADD COLUMN data jsonb;
ALTER TABLE takeoff.osp_segments      ADD COLUMN data jsonb;
ALTER TABLE takeoff.osp_callouts      ADD COLUMN data jsonb;
ALTER TABLE takeoff.osp_discrepancies ADD COLUMN data jsonb;

ALTER TABLE takeoff.osp_sheet_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.osp_sheet_runs FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON takeoff.osp_sheet_runs TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

-- confirm
SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'takeoff.osp_sheet_runs'::regclass) AS rls_on,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema='takeoff' AND column_name='data' AND table_name LIKE 'osp_%') AS data_cols;
