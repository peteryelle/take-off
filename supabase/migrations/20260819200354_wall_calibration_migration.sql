-- Applied directly against the live Take-off Supabase project
-- (lpjpqmpjxtwsnakcwqvb) via Supabase MCP — this file is the record of what
-- actually ran, kept in sync after a first attempt silently omitted the
-- org_id column (cause not understood; confirmed via drop/recreate + direct
-- verification of information_schema.columns, pg_class.relrowsecurity, and
-- pg_policies against the live DB, not just the tool's success response).
--
-- One row per project. Aggregate wall-signature scoring runs across every
-- pass_b_complete page in the project and writes ONE suggested row here.
-- Tier 3 (wall-aware) routing is gated on status = 'confirmed' — see
-- pass-batch.js routedPts(). Until confirmed, every page in the project
-- falls back to buildGreedyPath (Tier 1 waypoints), unchanged from today.
--
-- Scoring itself runs CLIENT-SIDE (multi-page.html, via wall-calibration.js's
-- scorePage/aggregateScores against the browser's own pdf.js page objects —
-- same pattern extractFilledSubpaths already uses for camera detection).
-- This table and its endpoint are pure CRUD: the client computes scores and
-- POSTs the result; nothing server-side loads a PDF. See page_wall_geometry
-- below for where the actual classified walls/doors get persisted, since
-- pass-batch.js needs geometry, not just knowledge of which signature won.
drop table if exists page_wall_geometry;
drop table if exists wall_calibrations;

create table wall_calibrations (
  id                bigint generated always as identity primary key,
  org_id            bigint not null references organizations(id),
  project_id        bigint not null references projects(id) on delete cascade,
  stroke_color      jsonb not null,        -- [r,g,b] 0..255, matches wall-calibration.js's roundColor output
  stroke_width      double precision not null,
  score             integer not null,      -- aggregate long-orthogonal-segment count, winning signature
  runner_up_score   integer,               -- second-place aggregate score, for the review card
  candidates        jsonb not null default '[]',  -- top ~5 [{color,width,score}], ranked. Lets
                                                     -- "try next candidate" advance without rescoring.
  candidate_idx     integer not null default 0,    -- which entry in candidates is currently suggested
  pages_evaluated   integer not null,
  pages_agreeing    integer not null,      -- how many pages independently picked this as their own top choice
  preview_page_id   bigint references pages(id),  -- which page's overlay to show on the review card
  status            text not null default 'suggested'
                      check (status in ('suggested','confirmed','rejected')),
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (project_id)   -- one calibration record per project; recalibrating replaces it
);

create index idx_wall_calibrations_project on wall_calibrations(project_id);

-- One row per page: the actual classified wall/door/tray geometry, computed
-- client-side (classifyGeometry, from wall-calibration.js) and persisted here
-- so pass-batch.js can read it and call buildPageRouter WITHOUT ever loading
-- the PDF server-side — wall-aware-path.js has zero DOM/PDF dependency by
-- design, so this table is what makes that true in practice, not just in
-- the module's own signature.
create table page_wall_geometry (
  id                    bigint generated always as identity primary key,
  org_id                bigint not null references organizations(id),
  page_id               bigint not null unique references pages(id) on delete cascade,
  project_id            bigint not null references projects(id) on delete cascade,
  wall_calibration_id   bigint references wall_calibrations(id),
  walls                 jsonb not null,   -- [[x1,y1,x2,y2], ...] — page-point space, y-down (see
                                            -- classifyGeometry's docstring for the flip convention)
  doors                 jsonb not null default '[]',  -- [{x,y}, ...]
  tray                  jsonb not null default '[]',  -- [{x,y}, ...], optional
  extracted_at          timestamptz not null default now()
);

create index idx_page_wall_geometry_project on page_wall_geometry(project_id);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────
-- Same "org_isolation" pattern already applied to demarcs/page_regions/
-- waypoints (queried directly from pg_policies to confirm, not guessed):
--   FOR ALL, USING and WITH CHECK both (org_id = auth_org_id()).
-- Note: the netlify functions for these two tables use the service-role
-- key (see utils/clients.js), which BYPASSES RLS — enforcement for
-- pass-wall-calibrate.js/pass-wall-geometry.js happens in application code
-- (requireOrg/assertProjectInOrg/assertPageInOrg), same as every other pass
-- function. This policy is the backstop for any future direct client-side
-- query against these tables using the anon/authenticated key.
alter table wall_calibrations   enable row level security;
alter table page_wall_geometry  enable row level security;

create policy org_isolation on wall_calibrations
  for all
  to authenticated
  using (org_id = auth_org_id())
  with check (org_id = auth_org_id());

create policy org_isolation on page_wall_geometry
  for all
  to authenticated
  using (org_id = auth_org_id())
  with check (org_id = auth_org_id());
