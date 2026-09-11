// netlify/functions/pass-rack-orchestrate.js
// Orchestration for Path A: tr_schedule_rows + tr_room_devices (confirmed) +
// project_fiber_config -> tr_rack_sizing. Every computation is delegated to
// public/lib/rack-orchestration.js (pure, fixtures-tested); this file only
// does the reads, the confirm-status write, and the persist.
//
// Actions:
//   confirm_room  — mark a TR's room-scan reviewed (tr_room_status ->
//                   'confirmed'). This is the human's explicit act in the
//                   confidence-map UI; nothing here infers confirmation from
//                   a scan simply having run.
//   size_tr       — run the orchestration for one tr_number and persist to
//                   tr_rack_sizing. No-ops (returns sized:false) if the room
//                   isn't confirmed yet, same as the pure module.
//   size_project  — size_tr for every schedule row in the project, for the
//                   status-view screen. Confirmed rooms get sized; others
//                   come back with their reason, same shape either way.
//
// POST /api/pass-rack-orchestrate
// Body: { action, project_id, ...action-specific fields }

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertProjectUnlocked } from "./utils/auth.js";
import { deriveRackCount, sizeTrRacks } from "../../public/lib/rack-orchestration.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST") return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { action, project_id } = body;
  if (!action) return err("action required");
  if (!project_id) return err("project_id required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId)))
    return err("Project not found in your organization", 404);

  switch (action) {
    case "confirm_room": return await actionConfirmRoom(supabase, orgId, body);
    case "size_tr":       return await actionSizeTr(supabase, orgId, body);
    case "size_project":  return await actionSizeProject(supabase, orgId, body);
    default: return err(`Unknown action: ${action}`);
  }
}

// ── confirm_room ─────────────────────────────────────────────────────────
// The only place tr_room_status ever moves to 'confirmed'. A prior scan run
// (pass-tr-room-rack-count.js) may have already written 'scanned' rows to
// tr_room_devices; this is a separate, explicit human act on top of that —
// see rack-orchestration.js's own header for why the two are never conflated.
async function actionConfirmRoom(supabase, orgId, body) {
  const { project_id, tr_number } = body;
  if (!tr_number) return err("tr_number required");

  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-running.", 423);

  const { error } = await supabase.from("tr_room_status").upsert({
    org_id: orgId, project_id, tr_number,
    status: "confirmed", confirmed_at: new Date(), updated_at: new Date(),
  }, { onConflict: "project_id,tr_number" });

  if (error) return err(`tr_room_status upsert failed: ${error.message}`, 500);
  return ok({ tr_number, status: "confirmed" });
}

// ── shared: read everything one TR's sizing needs ──────────────────────
async function loadInputs(supabase, project_id, tr_number) {
  const [scheduleRes, statusRes, devicesRes, fiberRes] = await Promise.all([
    supabase.from("tr_schedule_rows").select("tr_number, min_patch_panels")
      .eq("project_id", project_id).eq("tr_number", tr_number).maybeSingle(),
    supabase.from("tr_room_status").select("status")
      .eq("project_id", project_id).eq("tr_number", tr_number).maybeSingle(),
    supabase.from("tr_room_devices").select("category")
      .eq("project_id", project_id).eq("tr_number", tr_number),
    supabase.from("project_fiber_config").select("plant_type")
      .eq("project_id", project_id).maybeSingle(),
  ]);

  if (scheduleRes.error) throw new Error(`tr_schedule_rows read failed: ${scheduleRes.error.message}`);
  if (statusRes.error) throw new Error(`tr_room_status read failed: ${statusRes.error.message}`);
  if (devicesRes.error) throw new Error(`tr_room_devices read failed: ${devicesRes.error.message}`);
  if (fiberRes.error) throw new Error(`project_fiber_config read failed: ${fiberRes.error.message}`);

  const scheduleRow = scheduleRes.data;
  const status = statusRes.data?.status ?? "pending";
  // rack_count is derived from the CURRENT device rows every time, never
  // cached on tr_room_status itself -- a manual add/remove in the
  // confidence-map UI after confirmation must be reflected on the next
  // size_tr call without a second confirm step re-deriving it.
  const rackCount = deriveRackCount(devicesRes.data || []);
  const plantType = fiberRes.data?.plant_type ?? null;

  return { scheduleRow, roomStatus: { status, rack_count: rackCount }, plantType };
}

// ── size_tr ──────────────────────────────────────────────────────────────
async function actionSizeTr(supabase, orgId, body) {
  const { project_id, tr_number } = body;
  if (!tr_number) return err("tr_number required");

  let inputs;
  try { inputs = await loadInputs(supabase, project_id, tr_number); }
  catch (e) { return err(e.message, 500); }

  if (!inputs.scheduleRow) return err(`No tr_schedule_rows entry for "${tr_number}" in this project`, 404);

  const result = sizeTrRacks(inputs.scheduleRow, inputs.roomStatus, inputs.plantType);

  if (!result.sized) return ok(result); // pending/unconfirmed -- nothing to persist

  const { error } = await supabase.from("tr_rack_sizing").upsert({
    org_id: orgId, project_id, tr_number,
    rack_count: result.rack_count,
    patch_panel_distribution: result.patch_panel_distribution,
    sidecar_count: result.sidecar_count,
    fiber_cassette_count: result.fiber_cassette_count,
    fiber_pending: result.fiber_pending,
    computed_at: new Date(),
  }, { onConflict: "project_id,tr_number" });

  if (error) return err(`tr_rack_sizing upsert failed: ${error.message}`, 500);
  return ok(result);
}

// ── size_project ─────────────────────────────────────────────────────────
// Drives the rack-orchestration status view: every schedule row, sized where
// confirmed, flagged with its reason where not -- same shape as size_tr,
// just for the whole project in one call instead of one round trip per row.
async function actionSizeProject(supabase, orgId, body) {
  const { project_id } = body;

  const { data: rows, error } = await supabase
    .from("tr_schedule_rows").select("tr_number").eq("project_id", project_id);
  if (error) return err(`tr_schedule_rows read failed: ${error.message}`, 500);

  const results = [];
  for (const { tr_number } of rows || []) {
    const r = await actionSizeTr(supabase, orgId, { project_id, tr_number });
    const parsed = await r.json();
    results.push(parsed);
  }
  return ok({ count: results.length, results });
}

export const config = { path: "/api/pass-rack-orchestrate" };
