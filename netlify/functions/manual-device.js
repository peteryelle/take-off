// netlify/functions/manual-device.js
// Manage manual_devices — devices a human adds by hand on the confidence map
// when detection missed them.
//
// GET    /api/manual-device?page_id=123                — list manual devices for a page
// POST   /api/manual-device                             — add one
//   body: { project_id, page_id, device_type_id, x_norm, y_norm, uin? }
// DELETE /api/manual-device?id=456                      — remove one (undo a mis-click)
//
// This table is the durable source of truth, NOT device_instances — pass-batch.js
// re-injects every row here as a synthetic reconcile candidate on every run, before
// the exclude-zone filter (which a manual add bypasses — an explicit human
// placement overrides a general zone rule). That's what lets a manually-added
// device survive device_instances' delete-then-insert wipe on every re-run without
// needing any protective flag on that table.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list manual devices for a page ───────────────────────
  if (req.method === "GET") {
    const url     = new URL(req.url);
    const page_id = url.searchParams.get("page_id");
    if (!page_id) return err("page_id required");
    if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const { data, error } = await supabase
      .from("manual_devices")
      .select("id, page_id, device_type_id, x_norm, y_norm, uin, added_at")
      .eq("page_id", page_id)
      .order("id");
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — add a manually-placed device ─────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { project_id, page_id, device_type_id, x_norm, y_norm, uin } = body;
    if (!project_id || !page_id || !device_type_id || x_norm == null || y_norm == null)
      return err("project_id, page_id, device_type_id, x_norm, y_norm required");

    if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
    if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const { data, error } = await supabase
      .from("manual_devices")
      .insert({ project_id, page_id, device_type_id, x_norm, y_norm, uin: uin ?? null })
      .select("id, page_id, device_type_id, x_norm, y_norm, uin, added_at")
      .single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── DELETE — remove a manual device (undo) ──────────────────────
  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id  = url.searchParams.get("id");
    if (!id) return err("id required");

    const { data: row, error: findErr } = await supabase
      .from("manual_devices").select("id, project_id").eq("id", id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!row) return err("Manual device not found", 404);
    if (!(await assertProjectInOrg(supabase, row.project_id, orgId)))
      return err("Project not found in your organization", 404);

    const { error: delErr } = await supabase.from("manual_devices").delete().eq("id", id);
    if (delErr) return err(delErr.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/manual-device" };
