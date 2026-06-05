CREATE OR REPLACE VIEW public.v_project_list AS
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
    p.library_name
   FROM projects p
     LEFT JOIN project_pages pp ON pp.project_id = p.id AND pp.selected = true
     LEFT JOIN device_types dt ON dt.project_id = p.id
     LEFT JOIN device_instances di ON di.page_id = pp.page_id
     LEFT JOIN bom_items bi ON bi.project_id = p.id
  GROUP BY p.id
  ORDER BY p.updated_at DESC;
