// netlify/functions/pass-demarc.js
// Manage demarc points for a page — create, update, list
//
// GET  /api/pass-demarc?page_id=123              — list demarcs for page
// POST /api/pass-demarc                           — create/update demarc
// Body: {
//   project_id,
//   page_id,        -- null for project-level demarc
//   name,           -- "SL06" | "Exit to TR-4B"
//   source,         -- 'auto' | 'user_pin' | 'off_sheet'
//   x_norm,         -- null if off_sheet
//   y_norm,
//   stub_ft,        -- additional fixed distance (off-sheet runs)
//   region_id,      -- schematic (page_regions) this TR lives in; null = off-sheet/unscoped
//   note
// }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list demarcs ────────────────────────────────────────
  if (req.method === "GET") {
    const url     = new URL(req.url);
    const page_id = url.searchParams.get("page_id");
    const proj_id = url.searchParams.get("project_id");

    let query = supabase.from("demarcs").select("*").order("created_at");
    if (page_id) query = query.eq("page_id", page_id);
    if (proj_id) query = query.eq("project_id", proj_id);

    const { data, error } = await query;
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — upsert demarc ──────────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { project_id, page_id, name, source, x_norm, y_norm, stub_ft, region_id, note } = body;
    if (!project_id || !name || !source) return err("project_id, name and source required");

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const row = {
      project_id,
      page_id:  page_id ?? null,
      name,
      source,
      x_norm:   x_norm  ?? null,
      y_norm:   y_norm  ?? null,
      stub_ft:  stub_ft ?? 0,
      note:     note    ?? null
    };
    // Only set region_id when the caller supplies it, so a coords-only update
    // (e.g. an exit pin) never nulls an existing schematic link on upsert.
    if (region_id !== undefined) row.region_id = region_id ?? null;

    const { data, error } = await supabase
      .from("demarcs")
      .upsert(row, { onConflict: "project_id,name" })
      .select("*")
      .single();

    if (error) return err(error.message, 500);
    return ok(data);
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/pass-demarc" };
