-- A TR (demarc) lives in exactly one schematic (page_regions row).
-- This flips the schematic->TR relationship so a schematic can hold 1+ TRs:
--   schematic (page_regions) 1 --- N (demarcs.region_id) TR
-- page_regions.demarc_id is retained as the schematic's PRIMARY/home TR.
alter table demarcs
  add column region_id bigint references page_regions(id) on delete set null;

create index demarcs_region_id_idx on demarcs(region_id);
