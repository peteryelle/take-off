-- Take-Off v2 — Migration 4: per-project device verification + BOM output, snapshots, change orders

-- Project-owned libraries: copied types must be re-verified on the new set before counting
ALTER TABLE takeoff.device_types ADD COLUMN verified boolean NOT NULL DEFAULT false;
ALTER TABLE takeoff.device_types ADD COLUMN copied_from_type_id bigint REFERENCES takeoff.device_types(id) ON DELETE SET NULL;

-- BOM template = output layout and formulas only (nothing is read back from it)
CREATE TABLE takeoff.bom_templates (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES public.organizations(id),
  name          text   NOT NULL,
  storage_path  text   NOT NULL,
  section_map   jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE takeoff.projects
  ADD CONSTRAINT projects_bom_template_fk FOREIGN KEY (bom_template_id)
  REFERENCES takeoff.bom_templates(id) ON DELETE SET NULL;

CREATE TABLE takeoff.bom_sections (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES public.organizations(id),
  project_id    bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  section_code  text   NOT NULL,
  step_code     text   CHECK (step_code IN ('WF1','WF2','WF3','WF4','WF5','WF6','WF7','catalog')),
  status        text   NOT NULL DEFAULT 'empty'
                CHECK (status IN ('empty','filled','confirmed','stale','not_applicable')),
  stale_reason  text,
  confirmed_at  timestamptz,
  confirmed_by  uuid REFERENCES auth.users(id),
  UNIQUE (project_id, section_code)
);

-- Frozen snapshots: quantities, prices and the sheet revisions they came from
CREATE TABLE takeoff.bom_snapshots (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES public.organizations(id),
  project_id       bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  kind             text   NOT NULL CHECK (kind IN ('reference','generated','co')),
  label            text,
  workbook_path    text,
  quantities       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  prices           jsonb  NOT NULL DEFAULT '{}'::jsonb,
  sheet_revisions  jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION takeoff.block_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'bom_snapshots are immutable (id %)', OLD.id;
END;
$fn$;

ALTER FUNCTION takeoff.block_snapshot_update() SET search_path = '';

CREATE TRIGGER bom_snapshots_immutable
  BEFORE UPDATE ON takeoff.bom_snapshots
  FOR EACH ROW EXECUTE FUNCTION takeoff.block_snapshot_update();

CREATE TABLE takeoff.change_orders (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               bigint NOT NULL REFERENCES public.organizations(id),
  project_id           bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  number               text   NOT NULL,
  base_snapshot_id     bigint NOT NULL REFERENCES takeoff.bom_snapshots(id) ON DELETE RESTRICT,
  current_snapshot_id  bigint REFERENCES takeoff.bom_snapshots(id) ON DELETE RESTRICT,
  pricing_basis        text   NOT NULL CHECK (pricing_basis IN ('bid','current')),
  status               text   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  approved_at          timestamptz,
  approved_by          uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE takeoff.change_order_lines (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                    bigint NOT NULL REFERENCES public.organizations(id),
  project_id                bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  change_order_id           bigint NOT NULL REFERENCES takeoff.change_orders(id) ON DELETE CASCADE,
  bom_item                  text   NOT NULL,
  description               text,
  unit                      text,
  ref_qty                   numeric NOT NULL DEFAULT 0,
  cur_qty                   numeric NOT NULL DEFAULT 0,
  delta                     numeric GENERATED ALWAYS AS (cur_qty - ref_qty) STORED,
  unit_price                numeric(12,2),
  extended                  numeric GENERATED ALWAYS AS ((cur_qty - ref_qty) * unit_price) STORED,
  line_type                 text   NOT NULL CHECK (line_type IN ('add','credit')),
  cause_kind                text   CHECK (cause_kind IN ('revision','override_resolved','manual')),
  cause_sheet_revision_ids  bigint[],
  cause_note                text
);

CREATE INDEX idx_to_bom_sections_project ON takeoff.bom_sections(project_id);
CREATE INDEX idx_to_bom_snapshots_project ON takeoff.bom_snapshots(project_id, kind);
CREATE INDEX idx_to_change_orders_project ON takeoff.change_orders(project_id);
CREATE INDEX idx_to_co_lines_co ON takeoff.change_order_lines(change_order_id);

ALTER TABLE takeoff.bom_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.bom_templates FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.bom_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.bom_sections FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.bom_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.bom_snapshots FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.change_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.change_orders FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.change_order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.change_order_lines FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA takeoff TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

-- confirm: 31 tables, all rls_on, 31 policies; snapshot trigger present
SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='takeoff' AND c.relkind='r') AS tables,
       (SELECT count(*) FROM pg_policies WHERE schemaname='takeoff') AS policies,
       (SELECT count(*) FROM pg_trigger WHERE tgname='bom_snapshots_immutable') AS snapshot_trigger;
