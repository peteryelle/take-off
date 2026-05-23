// netlify/functions/takeoff-summary.js
// GET /api/takeoff-summary?project_id=1
// Returns full takeoff rollup, per-page summary, and TIA violations
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "GET")     return err("GET required", 405);

  const url        = new URL(req.url);
  const project_id = url.searchParams.get("project_id");
  if (!project_id) return err("project_id required");

  const supabase = getSupabase();

  const [rollup, pageSummary, violations, flagged] = await Promise.all([
    supabase.from("v_project_rollup")
      .select("*")
      .eq("project_name", await getProjectName(supabase, project_id)),
    supabase.from("v_page_summary")
      .select("*"),
    supabase.from("v_tia_violations")
      .select("*"),
    supabase.from("v_flagged")
      .select("*")
  ]);

  // Filter page summary to this project's pages
  const { data: pageIds } = await supabase
    .from("pages").select("id").eq("project_id", project_id);
  const idSet = new Set(pageIds?.map(p => p.id) ?? []);

  return ok({
    project_id,
    rollup:       rollup.data     ?? [],
    page_summary: (pageSummary.data ?? []),
    tia_violations: violations.data ?? [],
    flagged:      flagged.data    ?? []
  });
}

async function getProjectName(supabase, project_id) {
  const { data } = await supabase.from("projects").select("name").eq("id", project_id).single();
  return data?.name ?? "";
}

export const config = { path: "/api/takeoff-summary" };
