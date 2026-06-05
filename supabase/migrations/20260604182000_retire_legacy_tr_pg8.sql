-- Task 2b: retire the legacy 'TR-pg8' demarc (a duplicate of SDF0134).
--
-- Guarded: deletes ONLY if nothing references it — no device_instances.demarc_id,
-- no page_regions.demarc_id, and no demarcs.region_id (none should, but check all
-- FKs that point at a demarc). If any reference exists the DELETE is a no-op and the
-- row survives, so this is safe to push without a prior manual ref check. Identified
-- by name (project 5) rather than the hardcoded id (111) to stay id-agnostic.
--
-- If after pushing the row still exists, query the references and repoint them to
-- SDF0134 before re-running.
delete from demarcs d
where d.project_id = 5
  and d.name = 'TR-pg8'
  and not exists (select 1 from device_instances di where di.demarc_id = d.id)
  and not exists (select 1 from page_regions pr where pr.demarc_id = d.id)
  and not exists (select 1 from demarcs c where c.region_id is not null
                    and c.region_id in (select id from page_regions where demarc_id = d.id));
