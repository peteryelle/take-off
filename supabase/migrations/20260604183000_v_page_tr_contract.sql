-- Task C (data contract): the per-page TR/schematic binding the new DEMARC SCAN UI
-- reads. Generalizes the handoff's page-8 query into a project/page-agnostic view so
-- runDemarcScan can `select * from v_page_tr_contract where page_id = :pid` instead of
-- the browser deriving rooms from plan labels.
--
-- Per page it lists each distinct cable destination (TR room) from schedule_rows,
-- ranked by run count, joined to its demarc (by normalized name) and that demarc's
-- schematic (page_regions via demarcs.region_id). status tells the UI how to group:
--   'on this page'        — schematic is on this sheet (render under it)
--   'on another page'     — TR's schematic lives on a different sheet
--   'OFF-SHEET / unscoped'— demarc exists but has no schematic (region_id null)
--   'NO DEMARC — add + pin'— destination has no demarc row yet (offer "+ Add TR room")
--
-- Page-8 expected output: SDF0134 (101 runs, primary), MDF1000A3 (37, primary),
-- IDF1101A (3, off-sheet).
create or replace view v_page_tr_contract as
with dests as (
  select sr.project_id, sr.page_id, sr.dest, count(*) as runs
  from (
    select project_id, page_id, cable_dest_1 as dest from schedule_rows where cable_dest_1 is not null
    union all
    select project_id, page_id, cable_dest_2 as dest from schedule_rows where cable_dest_2 is not null
  ) sr
  group by sr.project_id, sr.page_id, sr.dest
)
select
  x.page_id,
  x.project_id,
  x.dest                     as tr_room,
  x.runs,
  d.id                       as demarc_id,
  d.x_norm                   as pin_x,
  d.y_norm                   as pin_y,
  d.stub_ft                  as stub_ft,
  pr.id                      as schematic_id,
  pr.page_id                 as schematic_page_id,
  pr.label                   as schematic,
  (d.x_norm is not null)     as pinned,
  (pr.demarc_id = d.id)      as is_primary,
  case
    when d.id is null            then 'NO DEMARC — add + pin'
    when d.region_id is null     then 'OFF-SHEET / unscoped'
    when pr.page_id = x.page_id  then 'on this page'
    else                              'on another page'
  end                        as status
from dests x
left join demarcs d
  on d.project_id = x.project_id
 and upper(replace(d.name, ' ', '')) = upper(replace(x.dest, ' ', ''))
left join page_regions pr on pr.id = d.region_id
order by x.page_id, x.runs desc;
