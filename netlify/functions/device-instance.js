// netlify/functions/device-instance.js
// PATCH /api/device-instance
//   { id, flags?, cull_category?, cull_reason? }
//
// Persists a device_instance's cull state directly on the row. Previously, a
// cull (confidence-map exclude) only ever created a preventive exclude-region in
// page_regions — that stops the SAME device from being re-detected on a FUTURE
// batch run, but never touched the CURRENT row's flags/cull_category/cull_reason,
// so a reload without a fresh run showed every culled device as if it had never
// been touched. Confirmed on a real project: 0 of 111 rows had manual_excluded
// in flags despite extensive culling having been done.
//
// Each field is independently optional (present-in-body vs absent, same pattern
// as set-page-role.js) — omitted fields are left untouched, so this can also be
// used to clear a cull (flags without manual_excluded, cull_category: null,
// cull_reason: null) without needing a separate endpoint.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "PATCH")   return err("PATCH required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { id } = body;
  if (!id) return err("id required");

  const hasFlags   = Object.prototype.hasOwnProperty.call(body, "flags");
  const hasCat     = Object.prototype.hasOwnProperty.call(body, "cull_category");
  const hasReason  = Object.prototype.hasOwnProperty.call(body, "cull_reason");
  if (!hasFlags && !hasCat && !hasReason)
    return err("at least one of flags, cull_category, cull_reason required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  const { data: row, error: findErr } = await supabase
    .from("device_instances").select("id, org_id").eq("id", id).maybeSingle();
  if (findErr) return err(findErr.message, 500);
  if (!row) return err("Device instance not found", 404);
  if (row.org_id !== orgId) return err("Device instance not found in your organization", 404);

  const updates = {};
  if (hasFlags)  updates.flags = body.flags;
  if (hasCat)    updates.cull_category = body.cull_category ?? null;
  if (hasReason) updates.cull_reason = body.cull_reason ?? null;

  const { error: updErr } = await supabase.from("device_instances").update(updates).eq("id", id);
  if (updErr) return err(updErr.message, 500);

  return ok({ id, ...updates });
}

export const config = { path: "/api/device-instance" };
