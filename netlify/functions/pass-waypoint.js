// netlify/functions/pass-waypoint.js
// Manage cable-routing waypoints for a page — Tier 1 point waypoints (see
// public/lib/waypoint-path.js for how they're chained into a routed distance).
//
// GET    /api/pass-waypoint?page_id=123 | ?project_id=9   — list waypoints
// POST   /api/pass-waypoint                                — create one
// Body: { project_id, page_id, x_norm, y_norm, label? }
// DELETE /api/pass-waypoint?id=456                          — remove one
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list waypoints ──────────────────────────────────────
  if (req.method === "GET") {
    const url     = new URL(req.url);
    const page_id = url.searchParams.get("page_id");
    const proj_id = url.searchParams.get("project_id");
    if (!page_id && !proj_id) return err("page_id or project_id required");

    let query = supabase.from("waypoints").select("*").order("created_at");
    if (page_id) query = query.eq("page_id", page_id);
    if (proj_id) query = query.eq("project_id", proj_id);

    const { data, error } = await query;
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — create a waypoint ──────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { project_id, page_id, x_norm, y_norm, label } = body;
    if (!project_id || !page_id) return err("project_id and page_id required");
    if (!Number.isFinite(x_norm) || !Number.isFinite(y_norm)) return err("x_norm and y_norm required");

    if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
    if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const { data, error } = await supabase
      .from("waypoints")
      .insert({ project_id, page_id, x_norm, y_norm, label: label ?? null })
      .select("*")
      .single();

    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── DELETE — remove a waypoint ────────────────────────────────
  // Unguarded, unlike demarcs: nothing persists a foreign key to a waypoint (the
  // greedy path is recomputed fresh from the live pool at every batch run, never
  // stored per-device), so deleting one just means the next run stops routing
  // through it. No orphan-reference risk.
  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id  = url.searchParams.get("id");
    if (!id) return err("id required");

    const { data: wp, error: findErr } = await supabase
      .from("waypoints")
      .select("id, project_id")
      .eq("id", id)
      .maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!wp) return err("Waypoint not found", 404);

    if (!(await assertProjectInOrg(supabase, wp.project_id, orgId)))
      return err("Project not found in your organization", 404);

    const { error: delErr } = await supabase.from("waypoints").delete().eq("id", id);
    if (delErr) return err(delErr.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/pass-waypoint" };
