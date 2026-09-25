-- ============================================================================
-- Take-Off v2 — Migration 1: core tables in a new `takeoff` schema
-- ============================================================================
-- Run each numbered block INDIVIDUALLY, top to bottom. Every change block is
-- followed by a confirm SELECT — run it and check the result before moving on.
-- Test on a dev branch / dev project first.
-- Nothing here touches the existing public.* tables.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0a. PRE-CHECK: how auth_org_id() is defined (return type must be bigint)
-- ----------------------------------------------------------------------------
SELECT p.proname, pg_get_function_result(p.oid) AS returns, n.nspname AS schema
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'auth_org_id';

-- ----------------------------------------------------------------------------
-- 0b. PRE-CHECK: organizations.id type (must be bigint)
-- ----------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'id';

-- STOP if 0a is not bigint or 0b is not bigint — send me the results.


-- ----------------------------------------------------------------------------
-- 1. Schema + grants
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS takeoff;

GRANT USAGE ON SCHEMA takeoff TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA takeoff
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA takeoff
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- confirm
SELECT nspname FROM pg_namespace WHERE nspname = 'takeoff';


-- ----------------------------------------------------------------------------
-- 2. projects — one per bid set
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.projects (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES public.organizations(id),
  name             text   NOT NULL,
  number           text,
  client           text,
  co_pricing_basis text   NOT NULL DEFAULT 'bid' CHECK (co_pricing_basis IN ('bid','current')),
  device_library_id bigint,   -- FK added in migration 3 (libraries)
  parts_catalog_id  bigint,   -- FK added in migration 3
  bom_template_id   bigint,   -- FK added in migration 4 (BOM)
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'projects' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 3. workflow_steps — one row per step per project (recommended order, no locks)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.workflow_steps (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES public.organizations(id),
  project_id   bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  step_code    text   NOT NULL CHECK (step_code IN ('WF1','WF2','WF3','WF4','WF5','WF6','WF7','WF8')),
  status       text   NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','extracted','in_review','confirmed','stale','not_applicable')),
  source_mode  text   NOT NULL DEFAULT 'drawings' CHECK (source_mode IN ('drawings','manual','mixed')),
  stale_reason text,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES auth.users(id),
  UNIQUE (project_id, step_code)
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'workflow_steps' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 4. documents — one per uploaded file (PDF now, .xlsx later for WF2 import)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.documents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES public.organizations(id),
  project_id   bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  step_code    text   NOT NULL CHECK (step_code IN ('WF1','WF2','WF3','WF4','WF5','WF6','WF7')),
  filename     text   NOT NULL,
  storage_path text   NOT NULL,
  mime_type    text   NOT NULL DEFAULT 'application/pdf'
               CHECK (mime_type IN ('application/pdf',
                                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  page_count   integer,
  status       text   NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','indexed','failed')),
  error        text,
  uploaded_by  uuid REFERENCES auth.users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'documents' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 5. sheets — one per sheet number per project (e.g. T1.5.K)
--    reference/current revision FKs are added in block 8
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.sheets (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                bigint NOT NULL REFERENCES public.organizations(id),
  project_id            bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  sheet_number          text   NOT NULL,
  title                 text,
  step_code             text CHECK (step_code IN ('WF1','WF2','WF3','WF4','WF5','WF6','WF7')),
  reference_revision_id bigint,
  current_revision_id   bigint,
  UNIQUE (project_id, sheet_number)
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'sheets' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 6. pages — one per PDF page; role, location, and change detection
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.pages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES public.organizations(id),
  project_id    bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  document_id   bigint NOT NULL REFERENCES takeoff.documents(id) ON DELETE CASCADE,
  page_number   integer NOT NULL,
  content_hash  text,
  title_text    text,
  sheet_id      bigint REFERENCES takeoff.sheets(id) ON DELETE SET NULL,
  role          text CHECK (role IN ('legend','notes','schedule','osp_route','osp_overview',
                                     'plan','key_plan','tr_room','rack','detail','riser','skip')),
  role_source   text CHECK (role_source IN ('suggested','rule','user')),
  building      text,
  level         text,
  zone          text,
  phase         text,
  is_duplicate  boolean NOT NULL DEFAULT false,
  UNIQUE (document_id, page_number)
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'pages' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 7. sheet_revisions — every upload of a sheet is a revision of it
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.sheet_revisions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES public.organizations(id),
  sheet_id       bigint NOT NULL REFERENCES takeoff.sheets(id) ON DELETE CASCADE,
  rev_label      text   NOT NULL,
  page_id        bigint NOT NULL REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  status         text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  superseded_by  bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  accepted_at    timestamptz,
  accepted_by    uuid REFERENCES auth.users(id),
  UNIQUE (sheet_id, rev_label)
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'sheet_revisions' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 8. sheets -> revision FKs (reference is protected: RESTRICT delete)
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.sheets
  ADD CONSTRAINT sheets_reference_revision_fk
  FOREIGN KEY (reference_revision_id) REFERENCES takeoff.sheet_revisions(id) ON DELETE RESTRICT;

ALTER TABLE takeoff.sheets
  ADD CONSTRAINT sheets_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL;

-- confirm
SELECT conname FROM pg_constraint
WHERE conrelid = 'takeoff.sheets'::regclass AND contype = 'f' ORDER BY conname;


-- ----------------------------------------------------------------------------
-- 9. role_rules — learned "sheet pattern -> role" rules (per project or library)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.role_rules (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  device_library_id bigint,   -- FK added in migration 3
  pattern           text   NOT NULL,
  role              text   NOT NULL CHECK (role IN ('legend','notes','schedule','osp_route','osp_overview',
                                                    'plan','key_plan','tr_room','rack','detail','riser','skip')),
  created_from      text,     -- e.g. 'confirmed 8 pages'
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'role_rules' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 10. extraction_runs — cost gate log (estimate -> approve -> run)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.extraction_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          bigint NOT NULL REFERENCES public.organizations(id),
  project_id      bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  step_code       text   NOT NULL CHECK (step_code IN ('WF1','WF2','WF3','WF4','WF5','WF6','WF7')),
  pages_total     integer NOT NULL DEFAULT 0,
  pages_reused    integer NOT NULL DEFAULT 0,
  pages_metered   integer NOT NULL DEFAULT 0,
  estimated_cost  numeric(10,2),
  actual_cost     numeric(10,2),
  status          text   NOT NULL DEFAULT 'estimated'
                  CHECK (status IN ('estimated','approved','running','succeeded','failed')),
  approved_by     uuid REFERENCES auth.users(id),
  approved_at     timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'takeoff' AND table_name = 'extraction_runs' ORDER BY ordinal_position;


-- ----------------------------------------------------------------------------
-- 11. Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX idx_to_documents_project ON takeoff.documents(project_id, step_code);
CREATE INDEX idx_to_pages_project     ON takeoff.pages(project_id, role);
CREATE INDEX idx_to_pages_sheet       ON takeoff.pages(sheet_id);
CREATE INDEX idx_to_pages_hash        ON takeoff.pages(project_id, content_hash);
CREATE INDEX idx_to_revisions_sheet   ON takeoff.sheet_revisions(sheet_id);
CREATE INDEX idx_to_runs_project      ON takeoff.extraction_runs(project_id, step_code);

-- confirm
SELECT indexname FROM pg_indexes WHERE schemaname = 'takeoff' ORDER BY indexname;


-- ----------------------------------------------------------------------------
-- 12. Row-level security — same pattern as public.* (org_id = public.auth_org_id())
--     Run each table's pair (ENABLE + CREATE POLICY) together, then confirm.
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.projects FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.workflow_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.workflow_steps FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.documents FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.sheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.sheets FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.pages FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.sheet_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.sheet_revisions FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.role_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.role_rules FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.extraction_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.extraction_runs FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

-- confirm: 8 rows, all rls_on = true, 8 policies
SELECT c.relname, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'takeoff' AND p.tablename = c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'takeoff' AND c.relkind = 'r'
ORDER BY c.relname;


-- ----------------------------------------------------------------------------
-- 13. Grants on the tables just created (default privileges only cover
--     tables created AFTER block 1 by the same role — this makes it certain)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA takeoff TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

-- confirm
SELECT table_name, string_agg(DISTINCT privilege_type, ',') AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'takeoff' AND grantee = 'authenticated'
GROUP BY table_name ORDER BY table_name;
