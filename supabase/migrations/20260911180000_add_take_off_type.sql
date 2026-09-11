-- projects.take_off_type — set once at project creation, not meant to change
-- after. A project row here is one PDF/one take-off (has its own
-- pdf_filename/storage_path), and a take-off is always fully one path or
-- the other in this pipeline: TR_design work (schedule + rack elevations +
-- TR room plans, no distance routing except a manual cable-tray trace) is
-- a different flow end-to-end from a floor-plan take-off (device stamps
-- routed to a demarc pin). Never both in one project.
--
-- Existing projects predate this column and default to 'floor_plan' --
-- that's every project's actual behavior up to now. Any that are really
-- TR_design take-offs (built before this flag existed) need a manual
-- one-time UPDATE, not an automatic reclassification from page roles --
-- guessing from roles risks silently reclassifying a project that's
-- legitimately mid-setup with a mixed or incomplete set of role tags.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS take_off_type text
  NOT NULL DEFAULT 'floor_plan'
  CHECK (take_off_type IN ('tr_design', 'floor_plan'));

-- v_project_list is an explicit column list, not SELECT * -- adding the
-- column to projects doesn't surface it here on its own, and /api/projects'
-- GET tries this view FIRST (only falls back to the base table if the view
-- query errors), so without this the type is invisible to every page that
-- reads the project list, multi-page.html's loadProjectCard included.
CREATE OR REPLACE VIEW v_project_list AS
 SELECT p.id,
    p.name,
    p.project_number,
    p.client,
    p.pdf_filename,
    p.pdf_page_count,
    p.created_at,
    p.updated_at,
    p.last_run_at,
    count(DISTINCT pp.page_id) AS pages_selected,
    count(DISTINCT dt.id) AS device_type_count,
    count(DISTINCT di.id) AS total_device_instances,
    count(DISTINCT bi.id) AS bom_line_count,
    p.is_library,
    p.library_name,
    p.org_id,
    p.pdf_storage_path,
    p.catalog_id,
    pc.name AS catalog_name,
    p.accepted_final_run_at,
    p.library_project_id,
    p.default_length_multiplier,
    p.fallback_length_multiplier,
    p.take_off_type
   FROM projects p
     LEFT JOIN project_pages pp ON pp.project_id = p.id AND pp.selected = true
     LEFT JOIN device_types dt ON dt.project_id = p.id
     LEFT JOIN device_instances di ON di.page_id = pp.page_id
     LEFT JOIN bom_items bi ON bi.project_id = p.id
     LEFT JOIN parts_catalogs pc ON pc.id = p.catalog_id
  GROUP BY p.id, pc.name
  ORDER BY p.updated_at DESC;
