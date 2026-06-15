// netlify/functions/page-regions.js
// Manage page_regions — the schematics on a page (one or more per sheet).
//
// GET  /api/page-regions?page_id=123                 — list regions for a page
// POST /api/page-regions                             — create a region, OR set its primary TR
//   create: { project_id, page_id, label, polygon:[[x,y],...], x0,y0,x1,y1 }
//   set primary: { id, demarc_id }                    — links the schematic's primary TR
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list regions for a page ─────────────────────────────
  if (req.method === "GET") {
    const url     = new URL(req.url);
    const page_id = url.searchParams.get("page_id");
    const proj_id = url.searchParams.get("project_id");
    let query = supabase.from("page_regions")
      .select("id, page_id, label, demarc_id, polygon, x0, y0, x1, y1")
      .order("id");
    if (page_id) query = query.eq("page_id", page_id);
    if (proj_id) query = query.eq("project_id", proj_id);
    const { data, error } = await query;
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — create a region, or set its primary TR ─────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    // Set-primary path: link an existing region to its primary TR (demarc).
    if (body.id != null && body.demarc_id !== undefined) {
      const { data, error } = await supabase
        .from("page_regions")
        .update({ demarc_id: body.demarc_id ?? null })
        .eq("id", body.id)
        .select("id, page_id, label, demarc_id")
        .single();
      if (error) return err(error.message, 500);
      return ok(data);
    }

    // Create path.
    const { project_id, page_id, label, polygon, x0, y0, x1, y1 } = body;
    if (!project_id || !page_id || !Array.isArray(polygon) || !polygon.length)
      return err("project_id, page_id and polygon required");

  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const row = {
      project_id, page_id,
      label:   label ?? null,
      polygon,
      x0: x0 ?? null, y0: y0 ?? null, x1: x1 ?? null, y1: y1 ?? null
    };
    const { data, error } = await supabase
      .from("page_regions")
      .insert(row)
      .select("id, page_id, label, demarc_id, polygon, x0, y0, x1, y1")
      .single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/page-regions" };
