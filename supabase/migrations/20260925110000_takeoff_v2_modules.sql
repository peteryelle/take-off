-- Take-Off v2 — Migration 2: module tables (all carry provenance columns)

-- WF2 schedule — the TR registry
CREATE TABLE takeoff.trs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  tr_number             text NOT NULL,
  building              text,
  level                 text,
  status                text CHECK (status IN ('new','existing','mix')),
  cat6a_terminations    integer,
  min_patch_panels      integer,
  cat_racks             integer,
  vertical_wire_managers integer,
  sheet_ref             text,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL),
  UNIQUE (project_id, tr_number)
);

CREATE INDEX idx_to_trs_project ON takeoff.trs(project_id);

-- WF1 legend — reference only (name suggestions, OSP line types)
CREATE TABLE takeoff.legend_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  legend_text       text,
  crop_path         text,
  line_style        text,
  line_meaning      text CHECK (line_meaning IN ('new_route','existing_route','tunnel','ignore')),
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_legend_entries_project ON takeoff.legend_entries(project_id);

-- WF1 notes that change how another step checks or counts
CREATE TABLE takeoff.project_notes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  note_ref          text,
  note_text         text NOT NULL,
  rule_kind         text CHECK (rule_kind IN ('pull_limit_ft','bend_limit_deg','phasing','other')),
  rule_value        numeric,
  used_by_step      text CHECK (used_by_step IN ('WF3','WF4','WF5','WF6','WF7','WF8')),
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_project_notes_project ON takeoff.project_notes(project_id);

-- WF3 vaults, junctions and building entries
CREATE TABLE takeoff.osp_nodes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  tr_name           text,
  tr_id             bigint REFERENCES takeoff.trs(id) ON DELETE SET NULL,
  label             text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('MH','HH','junction','end')),
  x_norm            double precision,
  y_norm            double precision,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_osp_nodes_project ON takeoff.osp_nodes(project_id);

-- WF3 runs between nodes
CREATE TABLE takeoff.osp_segments (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  label             text NOT NULL,
  from_node_id      bigint REFERENCES takeoff.osp_nodes(id) ON DELETE SET NULL,
  to_node_id        bigint REFERENCES takeoff.osp_nodes(id) ON DELETE SET NULL,
  route             text CHECK (route IN ('new','existing','tunnel')),
  total_ft          numeric,
  new_ft            numeric,
  existing_ft       numeric,
  bends_deg         numeric,
  core              text,
  cables            integer,
  n_4in             integer,
  n_1in_fa          integer,
  spare             integer,
  elec              boolean,
  pathway           text,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_osp_segments_project ON takeoff.osp_segments(project_id);

-- WF3 callout text matched to segments
CREATE TABLE takeoff.osp_callouts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  label             text NOT NULL,
  segment_id        bigint REFERENCES takeoff.osp_segments(id) ON DELETE SET NULL,
  callout_text      text NOT NULL,
  match_method      text CHECK (match_method IN ('leader','proximity')),
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_osp_callouts_project ON takeoff.osp_callouts(project_id);

-- WF3 RFI / verify log
CREATE TABLE takeoff.osp_discrepancies (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  label             text NOT NULL,
  category          text,
  status            text NOT NULL DEFAULT 'verify' CHECK (status IN ('rfi','verify','resolved')),
  located_at        text,
  expected          text,
  found             text,
  whats_off         text,
  rfi_text          text,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_osp_discrepancies_project ON takeoff.osp_discrepancies(project_id);

-- WF4 demarc pin per TR per plan page
CREATE TABLE takeoff.tr_pins (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  tr_name           text,
  tr_id             bigint REFERENCES takeoff.trs(id) ON DELETE SET NULL,
  x_norm            double precision NOT NULL,
  y_norm            double precision NOT NULL,
  placement         text NOT NULL DEFAULT 'auto_center' CHECK (placement IN ('auto_center','manual')),
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_tr_pins_project ON takeoff.tr_pins(project_id);

-- WF4 counted devices with routed length
CREATE TABLE takeoff.device_instances (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  tr_name           text,
  tr_id             bigint REFERENCES takeoff.trs(id) ON DELETE SET NULL,
  device_type_id    bigint,
  x_norm            double precision NOT NULL,
  y_norm            double precision NOT NULL,
  confidence        text CHECK (confidence IN ('high','medium','low')),
  route_ft_raw      numeric,
  route_method      text CHECK (route_method IN ('routed','fallback','none')),
  level             text,
  zone              text,
  excluded          boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_device_instances_project ON takeoff.device_instances(project_id);

-- WF5 room counts; cable_tray quantity is feet
CREATE TABLE takeoff.tr_room_devices (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  tr_name           text,
  tr_id             bigint REFERENCES takeoff.trs(id) ON DELETE SET NULL,
  category          text NOT NULL CHECK (category IN ('rack_new','rack_existing','wire_manager','access_control',
                                    'backboard','cable_tray','camera_connection','ground_busbar','motion_sensor','sleeves')),
  quantity          numeric NOT NULL,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_tr_room_devices_project ON takeoff.tr_room_devices(project_id);

-- WF6 typical elevations on T-501
CREATE TABLE takeoff.rack_elevations (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  detail_ref        text,
  rack_count        text CHECK (rack_count IN ('1','2','3','4','wall_mount')),
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_rack_elevations_project ON takeoff.rack_elevations(project_id);

-- WF6 parts and quantity rules from coded and drawing notes
CREATE TABLE takeoff.rack_rules (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  ref               text,
  item              text NOT NULL,
  part_number       text,
  qty_rule          text CHECK (qty_rule IN ('per_rack','racks_plus_one','schedule_div_racks','unused_ru','per_elevation','layout','not_stated')),
  zone              text CHECK (zone IN ('top','middle','bottom','side')),
  stated_on_sheet   boolean NOT NULL DEFAULT true,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_rack_rules_project ON takeoff.rack_rules(project_id);

-- WF7 backbone feeds per TR
CREATE TABLE takeoff.riser_feeds (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  tr_name           text,
  tr_id             bigint REFERENCES takeoff.trs(id) ON DELETE SET NULL,
  core_a            boolean NOT NULL DEFAULT false,
  core_b            boolean NOT NULL DEFAULT false,
  isp_osp           text CHECK (isp_osp IN ('isp','osp')),
  strands_per_core  text,
  osp_route_ok      boolean,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_riser_feeds_project ON takeoff.riser_feeds(project_id);

-- WF7 allowances from diagram notes
CREATE TABLE takeoff.allowances (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  system            text NOT NULL,
  item              text NOT NULL,
  per_unit_qty      numeric,
  unit              text,
  unit_count        integer,
  total             numeric GENERATED ALWAYS AS (per_unit_qty * unit_count) STORED,
  note_ref          text,
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL)
);

CREATE INDEX idx_to_allowances_project ON takeoff.allowances(project_id);

CREATE INDEX idx_to_tr_pins_tr ON takeoff.tr_pins(project_id, tr_name);

CREATE INDEX idx_to_device_instances_tr ON takeoff.device_instances(project_id, tr_name);

CREATE INDEX idx_to_tr_room_devices_tr ON takeoff.tr_room_devices(project_id, tr_name);

CREATE INDEX idx_to_riser_feeds_tr ON takeoff.riser_feeds(project_id, tr_name);

CREATE INDEX idx_to_device_instances_page ON takeoff.device_instances(page_id);

ALTER TABLE takeoff.trs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.trs FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.legend_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.legend_entries FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.project_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.project_notes FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.osp_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.osp_nodes FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.osp_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.osp_segments FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.osp_callouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.osp_callouts FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.osp_discrepancies ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.osp_discrepancies FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.tr_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.tr_pins FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.device_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.device_instances FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.tr_room_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.tr_room_devices FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.rack_elevations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.rack_elevations FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.rack_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.rack_rules FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.riser_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.riser_feeds FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.allowances ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.allowances FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA takeoff TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

-- confirm: 22 tables total, all rls_on, 1 policy each
SELECT c.relname, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname='takeoff' AND p.tablename=c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='takeoff' AND c.relkind='r' ORDER BY c.relname;
