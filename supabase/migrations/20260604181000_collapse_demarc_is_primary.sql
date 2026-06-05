-- Task 2a: collapse demarcs.is_primary on page 8 (project 5) to the per-schematic model.
--
-- Page 8 holds TWO schematics (demarcs.region_id -> page_regions): Segment A, whose
-- primary TR is SDF0134, and Segment B, whose primary TR is MDF1000A3. Under the
-- agreed per-schematic model each schematic owns exactly one primary TR, so BOTH
-- SDF0134 and MDF1000A3 stay primary — only the off-sheet, unscoped IDF1101A (no
-- schematic of its own) is demoted. This matches v_page_tr_contract.is_primary
-- (pr.demarc_id = d.id) and the DEMARC SCAN UI's page->schematic->TR grouping.
update demarcs set is_primary = false
where project_id = 5 and name = 'IDF1101A';

-- SDF0134 and MDF1000A3 remain is_primary = true (each its own schematic's primary);
-- left unchanged here so re-running is a no-op.
