// netlify/functions/pass-wall-geometry.js
//
// Persists ONE page's classified wall/door/tray geometry, computed
// client-side (classifyGeometry, from wall-calibration.js) against the
// confirmed project signature. This is what actually makes wall-aware-path.js
// usable from pass-batch.js: that module takes plain {walls, doors, tray}
// arrays and has zero DOM/PDF dependency, but something has to put those
// arrays somewhere pass-batch.js (server-side) can read them from — this
// table is that somewhere. No server-side PDF loading happens here or in
// pass-batch.js; the PDF only ever gets opened in the browser.
//
// Called once per page, right after wall_calibrations flips to 'confirmed'
// (client loops every page in the project, runs classifyGeometry against
// each, POSTs the result here) — not on every batch run, since the geometry
// doesn't change between runs, only the routes computed from it do.
//
// POST /api/pass-wall-geometry
//   Body: { page_id, project_id, walls, doors, tray? }
// GET  /api/pass-wall-geometry?page_id=123
//   Returns the persisted geometry for one page, or null if not yet extracted
//   (pass-batch.js should treat null the same as "no wall calibration" —
//   fall back to Tier 1 for that page).
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const page_id = url.searchParams.get("page_id");
    if (!page_id) return err("page_id required");
    if (!(await assertPageInOrg(supabase, page_id, orgId)))
      return err("Page not found in your organization", 404);
    const { data, error } = await supabase
      .from("page_wall_geometry").select("*").eq("page_id", page_id).maybeSingle();
    if (error) return err(error.message, 500);
    return ok(data); // null if not yet extracted for this page
  }

  if (req.method !== "POST") return err("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { page_id, project_id, walls, doors, tray } = body;
  if (!page_id || !project_id) return err("page_id and project_id required");
  if (!Array.isArray(walls)) return err("walls array required (even if empty)");
  if (!(await assertProjectInOrg(supabase, project_id, orgId)))
    return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId)))
    return err("Page not found in your organization", 404);

  const { data: calib } = await supabase
    .from("wall_calibrations").select("id").eq("project_id", project_id).maybeSingle();

  const row = {
    page_id, project_id, org_id: orgId,
    wall_calibration_id: calib?.id ?? null,
    walls, doors: doors ?? [], tray: tray ?? [],
    extracted_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("page_wall_geometry")
    .upsert(row, { onConflict: "page_id" })
    .select("*").single();
  if (error) return err(error.message, 500);
  return ok(data);
}
