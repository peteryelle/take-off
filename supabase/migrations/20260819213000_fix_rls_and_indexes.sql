-- Security: fix views running as SECURITY DEFINER (bypasses RLS for the
-- querying user, running with the view creator's privileges instead).
-- security_invoker = true makes each view respect the querying user's own
-- RLS policies, as it should for a multi-tenant, org-scoped app.
ALTER VIEW public.v_project_list SET (security_invoker = true);
ALTER VIEW public.v_project_rollup SET (security_invoker = true);
ALTER VIEW public.v_page_summary SET (security_invoker = true);
ALTER VIEW public.v_tia_violations SET (security_invoker = true);
ALTER VIEW public.v_flagged SET (security_invoker = true);
ALTER VIEW public.redundant_overall_suggestions SET (security_invoker = true);
ALTER VIEW public.v_page_tr_contract SET (security_invoker = true);
ALTER VIEW public.parts_priced SET (security_invoker = true);

-- Performance: profiles RLS policies re-evaluated auth.uid()/auth_org_id()
-- per row. Wrapping in (select ...) lets Postgres evaluate once per query
-- (initplan) instead of once per row.
DROP POLICY IF EXISTS profile_self_read ON public.profiles;
CREATE POLICY profile_self_read ON public.profiles
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS profile_self_update ON public.profiles;
CREATE POLICY profile_self_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND org_id = (select auth_org_id()));

-- Security: waypoints had an org_isolation policy defined, but RLS itself
-- was never enabled on the table, so the policy was never enforced.
ALTER TABLE public.waypoints ENABLE ROW LEVEL SECURITY;

-- Performance: missing covering indexes on foreign keys, which slows joins
-- and FK-constraint checks (especially cascading deletes). Covers both the
-- original audit findings and the newer tables (parts/wall-calibration
-- pipeline) added since.
CREATE INDEX IF NOT EXISTS idx_assembly_parts_assembly_id ON public.assembly_parts(assembly_id);
CREATE INDEX IF NOT EXISTS idx_batch_runs_project_id ON public.batch_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_assembly_id ON public.bom_items(assembly_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_demarc_id ON public.bom_items(demarc_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_device_instance_id ON public.bom_items(device_instance_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_project_id ON public.bom_items(project_id);
CREATE INDEX IF NOT EXISTS idx_demarcs_page_id ON public.demarcs(page_id);
CREATE INDEX IF NOT EXISTS idx_detection_runs_device_type_id ON public.detection_runs(device_type_id);
CREATE INDEX IF NOT EXISTS idx_detection_runs_page_id ON public.detection_runs(page_id);
CREATE INDEX IF NOT EXISTS idx_device_instances_device_type_id ON public.device_instances(device_type_id);
CREATE INDEX IF NOT EXISTS idx_device_types_source_project_id ON public.device_types(source_project_id);
CREATE INDEX IF NOT EXISTS idx_discovery_clusters_device_type_id ON public.discovery_clusters(device_type_id);
CREATE INDEX IF NOT EXISTS idx_discovery_results_cluster_id ON public.discovery_results(cluster_id);
CREATE INDEX IF NOT EXISTS idx_manual_devices_device_type_id ON public.manual_devices(device_type_id);
CREATE INDEX IF NOT EXISTS idx_manual_devices_project_id ON public.manual_devices(project_id);
CREATE INDEX IF NOT EXISTS idx_page_regions_demarc_id ON public.page_regions(demarc_id);
CREATE INDEX IF NOT EXISTS idx_project_pages_page_id ON public.project_pages(page_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_org_id ON public.waypoints(org_id);

-- New tables (parts/labor/wall-calibration pipeline) added since the last audit
CREATE INDEX IF NOT EXISTS idx_labor_tasks_catalog_id ON public.labor_tasks(catalog_id);
CREATE INDEX IF NOT EXISTS idx_labor_tasks_org_id ON public.labor_tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_page_wall_geometry_org_id ON public.page_wall_geometry(org_id);
CREATE INDEX IF NOT EXISTS idx_page_wall_geometry_wall_calibration_id ON public.page_wall_geometry(wall_calibration_id);
CREATE INDEX IF NOT EXISTS idx_parts_catalogs_org_id ON public.parts_catalogs(org_id);
CREATE INDEX IF NOT EXISTS idx_wall_calibrations_org_id ON public.wall_calibrations(org_id);
CREATE INDEX IF NOT EXISTS idx_wall_calibrations_preview_page_id ON public.wall_calibrations(preview_page_id);
