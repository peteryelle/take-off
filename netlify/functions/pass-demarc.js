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
//   note
// }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const supabase = getSupabase();

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

    const { project_id, page_id, name, source, x_norm, y_norm, stub_ft, note } = body;
    if (!project_id || !name || !source) return err("project_id, name and source required");

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
