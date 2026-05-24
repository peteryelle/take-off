// netlify/functions/takeoff-summary.js
// GET /api/takeoff-summary?project_id=1
// Returns full takeoff rollup, per-page summary, TIA violations, and device types
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "GET")     return err("GET required", 405);

  const url        = new URL(req.url);
  const project_id = parseInt(url.searchParams.get("project_id"));
  if (!project_id) return err("project_id required");

  const supabase = getSupabase();

  // Run all queries in parallel
  const [devicesRes, pagesRes, rollupRes, pageSummaryRes, violationsRes, flaggedRes] =
    await Promise.all([
      supabase.from("device_types")
        .select("id, legend_id, name, description, discipline, category, notes")
        .eq("project_id", project_id)
        .order("legend_id"),
      supabase.from("pages")
        .select("id, pdf_page_number, sheet_title, scale_label, demarc_label, demarc_type, pass_b_complete")
        .eq("project_id", project_id)
        .order("pdf_page_number"),
      supabase.from("v_project_rollup").select("*"),
      supabase.from("v_page_summary").select("*"),
      supabase.from("v_tia_violations").select("*"),
      supabase.from("v_flagged").select("*")
    ]);

  return ok({
    project_id,
    device_types:   devicesRes.data     ?? [],
    pages:          pagesRes.data       ?? [],
    rollup:         rollupRes.data      ?? [],
    page_summary:   pageSummaryRes.data ?? [],
    tia_violations: violationsRes.data  ?? [],
    flagged:        flaggedRes.data     ?? []
  });
}

export const config = { path: "/api/takeoff-summary" };
