-- WF7 Riser: everything read from the riser diagram sheet, each item confirmed by the user.

-- Cable types = the riser sheet's coded notes. A TR's ISP/OSP follows the cable on its cores.
CREATE TABLE takeoff.riser_cables (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  project_id        bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id           bigint REFERENCES takeoff.pages(id) ON DELETE SET NULL,
  note_number       integer NOT NULL,
  note_text         text NOT NULL,
  strands           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ n, type }] as read
  strands_per_core  numeric,
  strands_text      text,
  isp_osp           text CHECK (isp_osp IN ('isp','osp')),
  basis             text,                                  -- words the ISP/OSP suggestion was based on
  source            text NOT NULL DEFAULT 'extracted' CHECK (source IN ('extracted','edited','manual','imported')),
  sheet_revision_id bigint REFERENCES takeoff.sheet_revisions(id) ON DELETE SET NULL,
  original_value    jsonb,
  override_basis    text,
  conflict          jsonb,
  confirmed_at      timestamptz,
  confirmed_by      uuid REFERENCES auth.users(id),
  entered_by        uuid REFERENCES auth.users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source NOT IN ('edited','manual') OR override_basis IS NOT NULL),
  UNIQUE (project_id, note_number)
);
CREATE INDEX idx_to_riser_cables_project ON takeoff.riser_cables(project_id);
ALTER TABLE takeoff.riser_cables ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.riser_cables FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

-- One riser_feeds row per TR block on the riser. tr_name is the schedule (WF2) TR when the
-- block is in (matched, accepted or added in); null while it is out.
ALTER TABLE takeoff.riser_feeds
  ADD COLUMN riser_key     text,
  ADD COLUMN riser_label   text,
  ADD COLUMN building      text,
  ADD COLUMN floor         text,
  ADD COLUMN tr_name_read  text,
  ADD COLUMN core_a_note   integer,
  ADD COLUMN core_b_note   integer,
  ADD COLUMN match_kind    text CHECK (match_kind IN ('exact','close','manual','added')),
  ADD COLUMN suggested_tr  text,
  ADD COLUMN confirmed_at  timestamptz,
  ADD COLUMN confirmed_by  uuid REFERENCES auth.users(id);
ALTER TABLE takeoff.riser_feeds ADD CONSTRAINT riser_feeds_project_riser_key UNIQUE (project_id, riser_key);

-- Head-end callouts, e.g. "(60) 3" on CORE A — kept for the riser-vs-head-end check.
CREATE TABLE takeoff.riser_head_end (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES public.organizations(id),
  project_id  bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  page_id     bigint REFERENCES takeoff.pages(id) ON DELETE CASCADE,
  core        text,
  note_number integer NOT NULL,
  qty         integer NOT NULL
);
CREATE INDEX idx_to_riser_head_end_project ON takeoff.riser_head_end(project_id);
ALTER TABLE takeoff.riser_head_end ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.riser_head_end FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

-- Allowance lines from the diagram notes.
ALTER TABLE takeoff.allowances
  ADD COLUMN allowance_key text,
  ADD COLUMN per_text      text,
  ADD COLUMN confirmed_at  timestamptz,
  ADD COLUMN confirmed_by  uuid REFERENCES auth.users(id);
ALTER TABLE takeoff.allowances ADD CONSTRAINT allowances_project_key UNIQUE (project_id, allowance_key);
