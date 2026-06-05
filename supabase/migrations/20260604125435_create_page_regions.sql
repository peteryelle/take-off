-- A page can hold one or more independent schematics (e.g. page 8 = Level One
-- Segment A + Segment B). A region is a user-drawn closed boundary scoping a
-- schematic, carrying its own demarc/TR so distance/BOM routes each device to the
-- correct termination. Single-schematic sheets simply have one region = whole plan,
-- so the distance step needs no special-casing (N=1 is the same code path).
create table if not exists page_regions (
  id          bigint generated always as identity primary key,
  project_id  bigint not null,
  page_id     bigint not null references pages(id) on delete cascade,
  label       text,                          -- e.g. 'Level One - Segment A'
  polygon     jsonb not null,                -- [[x,y],...] normalized closed boundary (0..1)
  -- bbox of the polygon for fast containment pre-filter (app fills on save)
  x0 double precision,
  y0 double precision,
  x1 double precision,
  y1 double precision,
  demarc_id   bigint references demarcs(id) on delete set null,  -- TR this region routes to
  created_at  timestamptz not null default now()
);

create index if not exists idx_page_regions_page on page_regions(page_id);
create index if not exists idx_page_regions_project on page_regions(project_id);
