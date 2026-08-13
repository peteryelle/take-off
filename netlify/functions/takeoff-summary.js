// netlify/functions/takeoff-summary.js
// GET /api/takeoff-summary?project_id=1
// Returns full takeoff rollup, per-page summary, TIA violations, and device types
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "GET")     return err("GET required", 405);

  const url        = new URL(req.url);
  const project_id = parseInt(url.searchParams.get("project_id"));
  if (!project_id) return err("project_id required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);

  // Run all queries in parallel
  const [
    devicesRes, pagesRes, rollupRes, pageSummaryRes, violationsRes, flaggedRes,
    projectPagesRes, demarcsRes, instancesRes, regionsRes
  ] = await Promise.all([

    // Device types — full fields needed for detection and restore
    supabase.from("device_types")
      .select("id, legend_id, name, discipline, category, human_description, llm_description, text_anchors, detection_config, example_image_base64, assembly")
      .eq("project_id", project_id)
      .order("legend_id"),

    // Pages — slim summary (used by existing single-page views)
    supabase.from("pages")
      .select("id, pdf_page_number, sheet_title, scale_label, demarc_label, demarc_type, pass_b_complete")
      .eq("project_id", project_id)
      .order("pdf_page_number"),

    // Views
    supabase.from("v_project_rollup").select("*"),
    supabase.from("v_page_summary").select("*"),
    supabase.from("v_tia_violations").select("*"),
    supabase.from("v_flagged").select("*"),

    // ── Restore fields — what multi-page restore function reads ───
    // project_pages joined with pages for full page metadata
    supabase.from("project_pages")
      .select(`
        eval_page_num,
        page_id,
        pages (
          id, pdf_page_number, sheet_title, drawing_number,
          building, level, area, tr_name, tr_name_secondary, page_role,
          scale_paper_in, scale_real_ft,
          demarc_label, demarc_x, demarc_y, demarc_is_host,
          demarc_type, demarc_source,
          content_xmin_frac, content_ymin_frac, content_w_frac, content_h_frac
        )
      `)
      .eq("project_id", project_id)
      .order("eval_page_num"),

    // Demarcs — TR room pins and exit pins (region_id = schematic link, is_primary = schematic's primary TR)
    supabase.from("demarcs")
      .select("id, name, page_id, x_norm, y_norm, stub_ft, source, building, floor, area, region_id, is_primary")
      .eq("project_id", project_id)
      .order("name"),

    // Device instances — for batch result restore
    supabase.from("device_instances")
      .select(`
        id, page_id, device_type_id, detection_method,
        x_norm, y_norm, x_ft, y_ft,
        raw_labels, data_ports, voice_ports,
        port_count_data, port_count_voice,
        run_length_ft, total_ft, tia_flag, tia_reason,
        demarc_id, confidence, xy_source, symbol_via,
        device_types ( id, legend_id, name )
      `)
      .in("page_id",
        // subquery: all page_ids for this project
        (await supabase.from("pages").select("id").eq("project_id", project_id)).data?.map(p => p.id) ?? []
      ),

    // Page regions — schematics (one or more per page); demarc_id = the schematic's primary TR
    supabase.from("page_regions")
      .select("id, page_id, label, demarc_id, polygon, x0, y0, x1, y1")
      .eq("project_id", project_id)
      .order("page_id")
  ]);

  // Flatten project_pages rows — lift nested pages fields to top level
  const projectPages = (projectPagesRes.data ?? []).map(pp => ({
    eval_page_num:   pp.eval_page_num,
    page_id:         pp.page_id,
    sheet_title:     pp.pages?.sheet_title     ?? null,
    drawing_number:  pp.pages?.drawing_number  ?? null,
    building:        pp.pages?.building        ?? null,
    level:           pp.pages?.level           ?? null,
    area:            pp.pages?.area            ?? null,
    tr_name:         pp.pages?.tr_name         ?? null,
    tr_name_secondary: pp.pages?.tr_name_secondary ?? null,
    page_role:       pp.pages?.page_role       ?? null,
    scale_paper_in:  pp.pages?.scale_paper_in  ?? null,
    scale_real_ft:   pp.pages?.scale_real_ft   ?? null,
    demarc_label:    pp.pages?.demarc_label     ?? null,
    demarc_x:        pp.pages?.demarc_x        ?? null,
    demarc_y:        pp.pages?.demarc_y        ?? null,
    demarc_is_host:  pp.pages?.demarc_is_host  ?? null,
    demarc_type:     pp.pages?.demarc_type     ?? null,
    demarc_source:   pp.pages?.demarc_source   ?? null,
    content_xmin_frac: pp.pages?.content_xmin_frac ?? null,
    content_ymin_frac: pp.pages?.content_ymin_frac ?? null,
    content_w_frac:    pp.pages?.content_w_frac    ?? null,
    content_h_frac:    pp.pages?.content_h_frac    ?? null,
  }));

  // Annotate redundant-overall suggestions (advisory; the human confirms in the picker).
  // Reads the redundant_overall_suggestions view: a sheet titled "...OVERALL" that has
  // enlarged segment siblings (e.g. SE02-01 with SE02-01AB / SE02-01C / ...) would
  // double-count if tallied, so flag it for a one-click skip. Non-critical — never blocks.
  try {
    const { data: ros } = await supabase
      .from("redundant_overall_suggestions")
      .select("page_id, suggestion")
      .eq("project_id", project_id);
    const sug = new Map((ros ?? []).map(r => [r.page_id, r.suggestion]));
    for (const pg of projectPages) {
      if (sug.has(pg.page_id)) {
        pg.suggest_skip   = true;
        pg.suggest_reason = sug.get(pg.page_id);
      }
    }
  } catch (_) { /* suggestions are non-critical */ }

  // Flatten device instances — lift nested device_types fields
  const instances = (instancesRes.data ?? []).map(inst => ({
    ...inst,
    legend_id: inst.device_types?.legend_id ?? null,
    name:      inst.device_types?.name      ?? null,
    device_types: undefined   // strip nested object
  }));

  return ok({
    project_id,
    // Existing fields — unchanged for backward compat
    device_types:   devicesRes.data     ?? [],
    pages:          pagesRes.data       ?? [],
    rollup:         rollupRes.data      ?? [],
    page_summary:   pageSummaryRes.data ?? [],
    tia_violations: violationsRes.data  ?? [],
    flagged:        flaggedRes.data     ?? [],
    // New restore fields
    project_pages:    projectPages,
    demarcs:          demarcsRes.data   ?? [],
    page_regions:     regionsRes.data   ?? [],
    device_instances: instances
  });
}

export const config = { path: "/api/takeoff-summary" };