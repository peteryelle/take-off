// netlify/functions/tr-room-device.js
// Manage tr_room_devices — the add/remove backend for the TR-room
// confidence-map-style UI. Mirrors manual-device.js's shape exactly (GET
// list / POST add / DELETE remove), with one addition: tr_number, since one
// page can hold several TR rooms (T-401 series: up to 9 per sheet).
//
// GET    /api/tr-room-device?page_id=123&tr_number=A030A-1   — list devices for one room
// POST   /api/tr-room-device                                  — add one (always source:'manual')
//   body: { project_id, page_id, tr_number, coded_note_number?, coded_note_text?, x_norm, y_norm }
// DELETE /api/tr-room-device?id=456                            — remove one (vision or manual)
//
// POST always writes source:'manual', regardless of what the client sends —
// only pass-tr-room-vision.js writes source:'vision'. A human adding a
// device here is always a manual correction, never allowed to spoof a
// vision detection.
//
// DELETE removes ANY row regardless of source — unlike manual_devices'
// exclude-zone approach (which defends against a re-run silently
// re-detecting the same false positive), a re-run of pass-tr-room-vision.js
// only replaces source:'vision' rows, so deleting a vision-sourced false
// positive here is not yet protected against reappearing on the next vision
// re-run. Acceptable for a first version; a rejected-devices list (mirroring
// manual_devices/page-regions' exclude-zone precedent) would close that gap
// if it turns out to matter in practice.
//
// category is derived from coded_note_text via categorize-coded-note.js at
// add-time, same as pass-tr-room-vision.js does for vision detections — so
// a manually-added device rolls up into rack_count etc. the same way a
// vision-detected one does.

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
import { categorizeCodedNote } from "../../public/lib/categorize-coded-note.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  // ── GET — list devices for one TR room ──────────────────────────
  if (req.method === "GET") {
    const url       = new URL(req.url);
    const page_id   = url.searchParams.get("page_id");
    const tr_number = url.searchParams.get("tr_number");
    if (!page_id || !tr_number) return err("page_id and tr_number required");
    if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const { data, error } = await supabase
      .from("tr_room_devices")
      .select("id, page_id, tr_number, coded_note_number, coded_note_text, category, x_norm, y_norm, confidence, source, created_at")
      .eq("page_id", page_id)
      .eq("tr_number", tr_number)
      .order("id");
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── POST — add a manually-placed device ─────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }

    const { project_id, page_id, tr_number, coded_note_number, coded_note_text, x_norm, y_norm } = body;
    if (!project_id || !page_id || !tr_number || x_norm == null || y_norm == null)
      return err("project_id, page_id, tr_number, x_norm, y_norm required");

    if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
    if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);

    const { category } = coded_note_text ? categorizeCodedNote(coded_note_text) : { category: null };

    const { data, error } = await supabase
      .from("tr_room_devices")
      .insert({
        org_id: orgId,
        project_id,
        page_id,
        tr_number,
        coded_note_number: coded_note_number ?? null,
        coded_note_text: coded_note_text ?? null,
        category,
        x_norm,
        y_norm,
        confidence: null,     // a human placed this directly -- no detection confidence to record
        source: "manual",     // never trust a client-supplied source
      })
      .select("id, page_id, tr_number, coded_note_number, coded_note_text, category, x_norm, y_norm, confidence, source, created_at")
      .single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── DELETE — remove a device (vision false-positive, or undo a manual add) ──
  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id  = url.searchParams.get("id");
    if (!id) return err("id required");

    const { data: row, error: findErr } = await supabase
      .from("tr_room_devices").select("id, project_id").eq("id", id).maybeSingle();
    if (findErr) return err(findErr.message, 500);
    if (!row) return err("Device not found", 404);
    if (!(await assertProjectInOrg(supabase, row.project_id, orgId)))
      return err("Project not found in your organization", 404);

    const { error: delErr } = await supabase.from("tr_room_devices").delete().eq("id", id);
    if (delErr) return err(delErr.message, 500);
    return ok({ deleted: true, id: Number(id) });
  }

  return err("Method not allowed", 405);
}

export const config = { path: "/api/tr-room-device" };
