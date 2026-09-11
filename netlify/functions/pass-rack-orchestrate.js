// netlify/functions/pass-rack-orchestrate.js
// Orchestration for Path A: tr_schedule_rows.rack_count (already written by
// tr-room-review.html's "Save rack_count to TR Schedule" button) +
// project_fiber_config -> sized rack components. Every computation is
// delegated to public/lib/rack-orchestration.js (pure, fixtures-tested);
// this file only does the reads and the persist.
//
// No confirm step lives here -- tr_schedule_rows.rack_count IS the
// confirmation signal (null = unconfirmed), already written elsewhere.
// Adding a second confirmation table would give the app two sources of
// truth for the same fact; see rack-orchestration.js's own header.
//
// Actions:
//   size_tr       — run the orchestration for one tr_number and persist to
//                   tr_rack_sizing. Returns sized:false (nothing persisted)
//                   if rack_count is still null on the schedule row.
//   size_project  — size_tr for every schedule row in the project, for the
//                   status-view screen. Every row comes back sized or with
//                   its reason, same shape either way.
//
// POST /api/pass-rack-orchestrate
// Body: { action, project_id, ...action-specific fields }

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg } from "./utils/auth.js";
import { sizeTrRacks } from "../../public/lib/rack-orchestration.js";

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
    case "size_tr":      return await actionSizeTr(supabase, orgId, body);
    case "size_project": return await actionSizeProject(supabase, orgId, body);
    default: return err(`Unknown action: ${action}`);
  }
}

async function loadInputs(supabase, project_id, tr_number) {
  const [scheduleRes, fiberRes] = await Promise.all([
    supabase.from("tr_schedule_rows").select("tr_number, min_patch_panels, rack_count")
      .eq("project_id", project_id).eq("tr_number", tr_number).maybeSingle(),
    supabase.from("project_fiber_config").select("plant_type")
      .eq("project_id", project_id).maybeSingle(),
  ]);

  if (scheduleRes.error) throw new Error(`tr_schedule_rows read failed: ${scheduleRes.error.message}`);
  if (fiberRes.error) throw new Error(`project_fiber_config read failed: ${fiberRes.error.message}`);

  return { scheduleRow: scheduleRes.data, plantType: fiberRes.data?.plant_type ?? null };
}

async function actionSizeTr(supabase, orgId, body) {
  const { project_id, tr_number } = body;
  if (!tr_number) return err("tr_number required");

  let inputs;
  try { inputs = await loadInputs(supabase, project_id, tr_number); }
  catch (e) { return err(e.message, 500); }

  if (!inputs.scheduleRow) return err(`No tr_schedule_rows entry for "${tr_number}" in this project`, 404);

  const result = sizeTrRacks(inputs.scheduleRow, inputs.plantType);

  if (!result.sized) return ok(result); // unconfirmed -- nothing to persist

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
