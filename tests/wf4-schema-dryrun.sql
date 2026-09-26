-- WF4 schema dry run: migration 20260927100000 + test rows in one transaction, aborted at the end.
-- Nothing persists. The final error message DRYRUN_RESULT {...} is the result — expect:
-- instances_3=3, both rejects true, straight, 1.00, results_1=1, routed_rows_3=3, rls_on=true.
BEGIN;
-- Take-Off v2 — Migration 7: WF4 floor plans (Option C, minimal change)
--
-- Old public tables that already have a v2 home get the missing columns added
-- to that home (no parallel copies):
--   device_types   -> takeoff.device_types     (+ description/anchor/image columns)
--   demarcs        -> takeoff.tr_pins          (+ region, stub, location columns)
--   manual_devices -> takeoff.device_instances (source = 'manual')
--   device_instances -> takeoff.device_instances (+ detection detail columns)
--   pages          -> takeoff.pages            (+ scale / content-frame / run status)
-- Tables with no v2 home are copied in their existing shape:
--   page_regions, discovery_sessions, discovery_clusters, discovery_results,
--   and the Routed-mode tables: wall_calibrations, wall_calibration_runs,
--   page_wall_geometry, waypoints

-- ----------------------------------------------------------------------------
-- 1. Routing mode: per project, per-sheet override
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.projects
  ADD COLUMN route_mode       text    NOT NULL DEFAULT 'straight'
    CHECK (route_mode IN ('straight','right_angle','routed')),
  ADD COLUMN route_multiplier numeric NOT NULL DEFAULT 1.00
    CHECK (route_multiplier > 0);

ALTER TABLE takeoff.pages
  ADD COLUMN route_mode       text
    CHECK (route_mode IS NULL OR route_mode IN ('straight','right_angle','routed')),
  ADD COLUMN route_multiplier numeric
    CHECK (route_multiplier IS NULL OR route_multiplier > 0);

-- ----------------------------------------------------------------------------
-- 2. pages: what the old batch / symbol passes read and write
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.pages
  ADD COLUMN run_status        text NOT NULL DEFAULT 'pending'
    CHECK (run_status IN ('pending','running','done','error')),
  ADD COLUMN run_status_msg    text,
  ADD COLUMN scale_label       text,
  ADD COLUMN scale_paper_in    numeric,
  ADD COLUMN scale_real_ft     numeric,
  ADD COLUMN scale_pts_per_ft  numeric,
  ADD COLUMN drawing_x0        double precision,
  ADD COLUMN drawing_y0        double precision,
  ADD COLUMN drawing_x1        double precision,
  ADD COLUMN drawing_y1        double precision,
  ADD COLUMN content_xmin_frac double precision,
  ADD COLUMN content_ymin_frac double precision,
  ADD COLUMN content_w_frac    double precision,
  ADD COLUMN content_h_frac    double precision,
  ADD COLUMN sheet_class       jsonb,
  ADD COLUMN schedule          jsonb,
  ADD COLUMN leader_overrides  jsonb;

-- ----------------------------------------------------------------------------
-- 3. device_types: fields Discover writes (upsert key becomes library_id + name)
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.device_types
  ADD COLUMN legend_id            text,
  ADD COLUMN human_description    text,
  ADD COLUMN llm_description      text,
  ADD COLUMN text_anchors         jsonb,
  ADD COLUMN example_image_base64 text,
  ADD COLUMN tia_limit_ft         numeric,
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();

-- ----------------------------------------------------------------------------
-- 4. page_regions (existing shape; demarc_id -> tr_pin_id)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.page_regions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES public.organizations(id),
  project_id  bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id     bigint NOT NULL REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  label       text,
  polygon     jsonb  NOT NULL,
  x0          double precision,
  y0          double precision,
  x1          double precision,
  y1          double precision,
  tr_pin_id   bigint REFERENCES takeoff.tr_pins(id) ON DELETE SET NULL,
  kind        text   NOT NULL DEFAULT 'schematic' CHECK (kind IN ('schematic','exclude','tr_room')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_page_regions_page    ON takeoff.page_regions(page_id);
CREATE INDEX idx_to_page_regions_project ON takeoff.page_regions(project_id);

-- ----------------------------------------------------------------------------
-- 5. tr_pins: demarc fields the routing and review code uses
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.tr_pins
  ADD COLUMN region_id  bigint REFERENCES takeoff.page_regions(id) ON DELETE SET NULL,
  ADD COLUMN stub_ft    numeric NOT NULL DEFAULT 0,
  ADD COLUMN is_primary boolean NOT NULL DEFAULT true,
  ADD COLUMN node_codes text[],
  ADD COLUMN x_ft       double precision,
  ADD COLUMN y_ft       double precision,
  ADD COLUMN note       text;
CREATE INDEX idx_to_tr_pins_page ON takeoff.tr_pins(page_id);

-- ----------------------------------------------------------------------------
-- 6. device_instances: detection detail + new route methods
-- ----------------------------------------------------------------------------
-- Devices without coordinates are kept and flagged needs_placement (as today).
ALTER TABLE takeoff.device_instances ALTER COLUMN x_norm DROP NOT NULL;
ALTER TABLE takeoff.device_instances ALTER COLUMN y_norm DROP NOT NULL;

ALTER TABLE takeoff.device_instances DROP CONSTRAINT device_instances_route_method_check;
ALTER TABLE takeoff.device_instances ADD CONSTRAINT device_instances_route_method_check
  CHECK (route_method IN ('straight','right_angle','routed','fallback','none'));

ALTER TABLE takeoff.device_instances
  ADD COLUMN tr_pin_id        bigint REFERENCES takeoff.tr_pins(id) ON DELETE SET NULL,
  ADD COLUMN route_multiplier numeric,
  ADD COLUMN route_ft         numeric,            -- route_ft_raw x multiplier + stub
  ADD COLUMN route_geometry   jsonb,
  ADD COLUMN routed_via_tier3 boolean NOT NULL DEFAULT false,
  ADD COLUMN detection_method text NOT NULL DEFAULT 'text_extract',
  ADD COLUMN uin              text,
  ADD COLUMN x_ft             numeric,
  ADD COLUMN y_ft             numeric,
  ADD COLUMN raw_labels       text[],
  ADD COLUMN data_ports       text[],
  ADD COLUMN voice_ports      text[],
  ADD COLUMN node_labels      text[],
  ADD COLUMN port_count_data  integer,
  ADD COLUMN port_count_voice integer,
  ADD COLUMN tia_flag         boolean NOT NULL DEFAULT false,
  ADD COLUMN tia_reason       text,
  ADD COLUMN flags            text[],
  ADD COLUMN xy_source        text,
  ADD COLUMN symbol_via       text,
  ADD COLUMN has_leader       boolean,
  ADD COLUMN leader_x         double precision,
  ADD COLUMN leader_y         double precision,
  ADD COLUMN cull_category    text,
  ADD COLUMN cull_reason      text;
CREATE INDEX idx_to_device_instances_tr_pin ON takeoff.device_instances(tr_pin_id);

-- ----------------------------------------------------------------------------
-- 7. Discover (existing shape; ids widened to bigint to match v2)
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.discovery_sessions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              bigint NOT NULL REFERENCES public.organizations(id),
  project_id          bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  status              text   NOT NULL DEFAULT 'scanning',
  status_msg          text,
  sample_page_numbers integer[],
  legend_page_numbers integer[],
  clusters_found      integer DEFAULT 0,
  clusters_high       integer DEFAULT 0,
  clusters_medium     integer DEFAULT 0,
  clusters_low        integer DEFAULT 0,
  clusters_noise      integer DEFAULT 0,
  scan_started_at     timestamptz,
  scan_completed_at   timestamptz,
  review_started_at   timestamptz,
  review_completed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_discovery_sessions_project ON takeoff.discovery_sessions(project_id);

CREATE TABLE takeoff.discovery_clusters (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              bigint NOT NULL REFERENCES public.organizations(id),
  session_id          bigint NOT NULL REFERENCES takeoff.discovery_sessions(id) ON DELETE CASCADE,
  project_id          bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  cluster_id          text   NOT NULL,
  cluster_index       integer,
  visual_description  text   NOT NULL,
  nearby_text         text[],
  approximate_count   integer,
  location_pattern    text,
  source_strip        integer,
  is_noise            boolean NOT NULL DEFAULT false,
  noise_reason        text,
  legend_name         text,
  legend_description  text,
  match_confidence    text,
  match_reason        text,
  drawing_crop_base64 text,
  legend_crop_base64  text,
  review_status       text   NOT NULL DEFAULT 'pending',
  reviewed_at         timestamptz,
  final_name          text,
  detect_on_run       boolean NOT NULL DEFAULT false,
  device_type_id      bigint REFERENCES takeoff.device_types(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, cluster_id)
);
CREATE INDEX idx_to_discovery_clusters_project ON takeoff.discovery_clusters(project_id);

CREATE TABLE takeoff.discovery_results (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             bigint NOT NULL REFERENCES public.organizations(id),
  session_id         bigint REFERENCES takeoff.discovery_sessions(id) ON DELETE SET NULL,
  project_id         bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  cluster_id         bigint REFERENCES takeoff.discovery_clusters(id) ON DELETE SET NULL,
  device_type_id     bigint NOT NULL REFERENCES takeoff.device_types(id) ON DELETE CASCADE,
  confirmed_name     text   NOT NULL,
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  approval_method    text   NOT NULL DEFAULT 'human_approved',
  visual_description text,
  nearby_text        text[],
  match_confidence   text,
  approximate_count  integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_discovery_results_project ON takeoff.discovery_results(project_id);

-- ----------------------------------------------------------------------------
-- 8. Routed mode (existing shape): wall calibration, wall geometry, waypoints
-- ----------------------------------------------------------------------------
CREATE TABLE takeoff.wall_calibrations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES public.organizations(id),
  project_id       bigint NOT NULL UNIQUE REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  stroke_color     jsonb  NOT NULL,
  stroke_width     double precision NOT NULL,
  score            integer NOT NULL,
  runner_up_score  integer,
  candidates       jsonb  NOT NULL DEFAULT '[]'::jsonb,
  candidate_idx    integer NOT NULL DEFAULT 0,
  pages_evaluated  integer NOT NULL,
  pages_agreeing   integer NOT NULL,
  preview_page_id  bigint REFERENCES takeoff.pages(id) ON DELETE SET NULL,
  status           text   NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','rejected')),
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE takeoff.wall_calibration_runs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES public.organizations(id),
  project_id       bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  ran_at           timestamptz NOT NULL DEFAULT now(),
  outcome          text   NOT NULL CHECK (outcome IN ('confirmed','rejected')),
  score            numeric,
  runner_up_score  numeric,
  pages_agreeing   integer,
  pages_evaluated  integer
);
CREATE INDEX idx_to_wall_calibration_runs_project ON takeoff.wall_calibration_runs(project_id);

CREATE TABLE takeoff.page_wall_geometry (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              bigint NOT NULL REFERENCES public.organizations(id),
  page_id             bigint NOT NULL UNIQUE REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  project_id          bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  wall_calibration_id bigint REFERENCES takeoff.wall_calibrations(id) ON DELETE SET NULL,
  walls               jsonb  NOT NULL,
  doors               jsonb  NOT NULL DEFAULT '[]'::jsonb,
  tray                jsonb  NOT NULL DEFAULT '[]'::jsonb,
  extracted_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_page_wall_geometry_project ON takeoff.page_wall_geometry(project_id);

CREATE TABLE takeoff.waypoints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES public.organizations(id),
  project_id  bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id     bigint NOT NULL REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  x_norm      double precision NOT NULL,
  y_norm      double precision NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_to_waypoints_page ON takeoff.waypoints(page_id);

-- ----------------------------------------------------------------------------
-- 9. RLS + grants on the new tables
-- ----------------------------------------------------------------------------
ALTER TABLE takeoff.page_regions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.page_regions FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.discovery_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.discovery_sessions FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.discovery_clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.discovery_clusters FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.discovery_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.discovery_results FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

ALTER TABLE takeoff.wall_calibrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.wall_calibrations FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.wall_calibration_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.wall_calibration_runs FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.page_wall_geometry ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.page_wall_geometry FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.waypoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.waypoints FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA takeoff TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

DO $t$
DECLARE o bigint; p bigint; d bigint; pg bigint; lib bigint; dt bigint; pin bigint; reg bigint;
        s bigint; cl bigint; wc bigint; ok_manual_reject boolean := false; ok_route_reject boolean := false;
BEGIN
  SELECT id INTO o FROM public.organizations ORDER BY id LIMIT 1;
  INSERT INTO takeoff.projects(org_id,name) VALUES (o,'__wf4_dryrun') RETURNING id INTO p;
  INSERT INTO takeoff.documents(org_id,project_id,step_code,filename,storage_path)
    VALUES (o,p,'WF4','t.pdf','v2/x/t.pdf') RETURNING id INTO d;
  INSERT INTO takeoff.pages(org_id,project_id,document_id,page_number,role,scale_pts_per_ft,route_mode)
    VALUES (o,p,d,1,'plan',6.0,'right_angle') RETURNING id INTO pg;
  INSERT INTO takeoff.device_libraries(org_id,name,project_id) VALUES (o,'__wf4_lib',p) RETURNING id INTO lib;
  INSERT INTO takeoff.device_types(org_id,library_id,name,legend_id,text_anchors,llm_description)
    VALUES (o,lib,'DD2','DD2','["DD2"]','dual data') RETURNING id INTO dt;
  INSERT INTO takeoff.page_regions(org_id,project_id,page_id,polygon,kind)
    VALUES (o,p,pg,'[[0,0],[1,0],[1,1]]','schematic') RETURNING id INTO reg;
  INSERT INTO takeoff.tr_pins(org_id,project_id,page_id,tr_name,x_norm,y_norm,region_id,stub_ft)
    VALUES (o,p,pg,'EB51A',0.5,0.5,reg,10) RETURNING id INTO pin;
  UPDATE takeoff.page_regions SET tr_pin_id = pin WHERE id = reg;
  INSERT INTO takeoff.device_instances(org_id,project_id,page_id,device_type_id,tr_pin_id,x_norm,y_norm,
      route_method,route_ft_raw,route_multiplier,route_ft,raw_labels,flags,uin)
    VALUES (o,p,pg,dt,pin,0.2,0.3,'straight',80,1.0,90,ARRAY['DD2'],ARRAY['ok'],'A-101');
  -- no coordinates -> needs_placement, must be allowed
  INSERT INTO takeoff.device_instances(org_id,project_id,page_id,device_type_id,flags)
    VALUES (o,p,pg,dt,ARRAY['needs_placement']);
  -- manual row with basis: allowed
  INSERT INTO takeoff.device_instances(org_id,project_id,page_id,device_type_id,x_norm,y_norm,source,override_basis,detection_method)
    VALUES (o,p,pg,dt,0.4,0.4,'manual','placed manually on plan','manual');
  -- manual row without basis: must be rejected
  BEGIN
    INSERT INTO takeoff.device_instances(org_id,project_id,page_id,device_type_id,x_norm,y_norm,source)
      VALUES (o,p,pg,dt,0.1,0.1,'manual');
  EXCEPTION WHEN check_violation THEN ok_manual_reject := true; END;
  -- bad route method: must be rejected
  BEGIN
    INSERT INTO takeoff.device_instances(org_id,project_id,page_id,device_type_id,route_method)
      VALUES (o,p,pg,dt,'diagonal');
  EXCEPTION WHEN check_violation THEN ok_route_reject := true; END;
  INSERT INTO takeoff.discovery_sessions(org_id,project_id,status,sample_page_numbers) VALUES (o,p,'review',ARRAY[1]) RETURNING id INTO s;
  INSERT INTO takeoff.discovery_clusters(org_id,session_id,project_id,cluster_id,visual_description,nearby_text,device_type_id)
    VALUES (o,s,p,'c1','triangle w/ DD2',ARRAY['DD2'],dt) RETURNING id INTO cl;
  INSERT INTO takeoff.discovery_results(org_id,session_id,project_id,cluster_id,device_type_id,confirmed_name)
    VALUES (o,s,p,cl,dt,'DD2');
  -- Routed mode chain
  INSERT INTO takeoff.wall_calibrations(org_id,project_id,stroke_color,stroke_width,score,pages_evaluated,pages_agreeing,preview_page_id,status)
    VALUES (o,p,'[0,0,0]',0.72,9,3,3,pg,'confirmed') RETURNING id INTO wc;
  INSERT INTO takeoff.wall_calibration_runs(org_id,project_id,outcome,score) VALUES (o,p,'confirmed',9);
  INSERT INTO takeoff.page_wall_geometry(org_id,page_id,project_id,wall_calibration_id,walls) VALUES (o,pg,p,wc,'[]');
  INSERT INTO takeoff.waypoints(org_id,project_id,page_id,x_norm,y_norm) VALUES (o,p,pg,0.3,0.3);
  UPDATE takeoff.device_instances SET route_method='routed' WHERE project_id=p AND uin='A-101';
  RAISE EXCEPTION 'DRYRUN_RESULT %', (SELECT row_to_json(r) FROM (SELECT
    (SELECT count(*) FROM takeoff.device_instances WHERE project_id=p) AS instances_3,
    ok_manual_reject, ok_route_reject,
    (SELECT route_mode FROM takeoff.projects WHERE id=p) AS project_mode_straight,
    (SELECT route_multiplier FROM takeoff.projects WHERE id=p) AS project_mult_1,
    (SELECT count(*) FROM takeoff.discovery_results WHERE project_id=p) AS results_1,
    (SELECT count(*) FROM takeoff.waypoints WHERE project_id=p)
      + (SELECT count(*) FROM takeoff.page_wall_geometry WHERE project_id=p)
      + (SELECT count(*) FROM takeoff.wall_calibration_runs WHERE project_id=p) AS routed_rows_3,
    (SELECT bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='takeoff' AND c.relname IN ('page_regions','discovery_sessions','discovery_clusters','discovery_results','wall_calibrations','wall_calibration_runs','page_wall_geometry','waypoints')) AS rls_on) r);
END $t$;
