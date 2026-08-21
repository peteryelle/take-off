// netlify/functions/pass-wall-calibrate.js
//
// Project-level wall-signature calibration — CRUD only. Scoring itself runs
// CLIENT-SIDE (multi-page.html, via wall-calibration.js's scorePage/
// aggregateScores against the browser's own pdf.js page objects — same
// pattern extractFilledSubpaths already uses for camera detection). This
// endpoint never loads a PDF; it receives the client's computed candidate
// list and writes/updates one row. Tier 3 (wall-aware) routing in
// pass-batch.js's routedPts() is gated on status = 'confirmed'. Unconfirmed/
// rejected -> every page falls back to buildGreedyPath (Tier 1 waypoints).
//
// Single exact path, action dispatched from the request body — matching
// every other multi-verb endpoint in this project (see page-regions.js,
// which branches on req.method + body fields, not a URL suffix). An earlier
// version of this file used /api/pass-wall-calibrate/confirm etc. as literal
// URL paths with a wildcard `config.path`; that 404'd in production because
// it didn't match this project's routing convention. Fixed here.
//
// GET  /api/pass-wall-calibrate?project_id=123   — current calibration (or null)
// POST /api/pass-wall-calibrate
//   Body: { project_id, action?: 'confirm'|'reject'|'try-next' }
//   - action omitted: write a new 'suggested' row from
//       { candidates: [{color,width,score}, ...] (ranked, highest first),
//         pages_evaluated, pages_agreeing, preview_page_id }
//   - action: 'confirm'  — confirm the current suggestion
//   - action: 'reject'   — reject; project stays on Tier 1. Flags every
//       device routed while this calibration was confirmed as
//       wall_calibration_stale, so a since-rejected signature's output is
//       findable in the existing audit/cull UI, not silently left on record.
//   - action: 'try-next' — advance to the next-ranked candidate without
//       rescoring (candidates were already computed and stored).
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg } from "./utils/auth.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  const url = new URL(req.url);

  // ── GET — current calibration status for a project ─────────────
  if (req.method === "GET") {
    const project_id = url.searchParams.get("project_id");
    if (!project_id) return err("project_id required");
    if (!(await assertProjectInOrg(supabase, project_id, orgId)))
      return err("Project not found in your organization", 404);
    const { data, error } = await supabase
      .from("wall_calibrations").select("*").eq("project_id", project_id).maybeSingle();
    if (error) return err(error.message, 500);
    return ok(data); // null if never run
  }

  if (req.method !== "POST") return err("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }
  const { project_id, action } = body;
  if (!project_id) return err("project_id required");
  if (!(await assertProjectInOrg(supabase, project_id, orgId)))
    return err("Project not found in your organization", 404);

  // ── action: 'confirm' ────────────────────────────────────────
  // Idempotent: if the row is already 'confirmed' (e.g. a second click after
  // the first one already succeeded), return the current row instead of
  // erroring. The .eq('status','suggested') filter matching zero rows on a
  // re-click is exactly what produced "Cannot coerce the result to a single
  // JSON object" in testing — confirmed live, not guessed.
  if (action === "confirm") {
    const { data: existing, error: exErr } = await supabase
      .from("wall_calibrations").select("*").eq("project_id", project_id).maybeSingle();
    if (exErr) return err(exErr.message, 500);
    if (!existing) return err("No calibration to confirm", 404);
    if (existing.status === "confirmed") return ok(existing); // already done — not an error

    const { data, error } = await supabase
      .from("wall_calibrations")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("project_id", project_id).eq("status", "suggested")
      .select("*").single();
    if (error) return err(error.message, 500);

    // Append-only log for deriving the auto-accept margin threshold later —
    // see wall_calibration_runs' table comment. Fire-and-forget: a logging
    // failure must never block the actual confirm.
    await supabase.from("wall_calibration_runs").insert({
      project_id, outcome: "confirmed",
      score: data.score, runner_up_score: data.runner_up_score,
      pages_agreeing: data.pages_agreeing, pages_evaluated: data.pages_evaluated,
    }).then(null, (e) => console.error("wall_calibration_runs log insert failed:", e));

    return ok(data);
  }

  // ── action: 'reject' ─────────────────────────────────────────
  if (action === "reject") {
    const { data: prior } = await supabase
      .from("wall_calibrations").select("status").eq("project_id", project_id).maybeSingle();
    const wasConfirmed = prior?.status === "confirmed";

    const { data, error } = await supabase
      .from("wall_calibrations")
      .update({ status: "rejected" })
      .eq("project_id", project_id)
      .select("*").single();
    if (error) return err(error.message, 500);

    // Same append-only log as the confirm branch above — captures the
    // ambiguous/losing case too, since deriving a real threshold needs both
    // sides of the distribution, not just the wins.
    await supabase.from("wall_calibration_runs").insert({
      project_id, outcome: "rejected",
      score: data.score, runner_up_score: data.runner_up_score,
      pages_agreeing: data.pages_agreeing, pages_evaluated: data.pages_evaluated,
    }).then(null, (e) => console.error("wall_calibration_runs log insert failed:", e));

    if (wasConfirmed) {
      const { data: pages } = await supabase.from("pages").select("id").eq("project_id", project_id);
      const pageIds = (pages ?? []).map((p) => p.id);
      let flaggedCount = 0;
      if (pageIds.length) {
        const { data: affected } = await supabase
          .from("device_instances").select("id, flags")
          .in("page_id", pageIds).not("total_ft", "is", null);
        for (const d of affected ?? []) {
          const flags = new Set(d.flags ?? []);
          flags.add("wall_calibration_stale");
          await supabase.from("device_instances").update({ flags: [...flags] }).eq("id", d.id);
        }
        flaggedCount = affected?.length ?? 0;
      }
      data.devices_flagged_stale = flaggedCount;
    }
    return ok(data);
  }

  // ── action: 'try-next' — advance to the next-ranked candidate ──
  if (action === "try-next") {
    const { data: cur, error: curErr } = await supabase
      .from("wall_calibrations").select("*").eq("project_id", project_id).maybeSingle();
    if (curErr) return err(curErr.message, 500);
    if (!cur) return err("No calibration to advance", 404);
    const nextIdx = cur.candidate_idx + 1;
    const next = cur.candidates[nextIdx];
    if (!next) return err("No further candidates — reject and use waypoints, or recalibrate", 200);

    const { data, error } = await supabase
      .from("wall_calibrations")
      .update({
        stroke_color: next.color, stroke_width: next.width, score: next.score,
        runner_up_score: cur.candidates[nextIdx + 1]?.score ?? null,
        candidate_idx: nextIdx, status: "suggested", confirmed_at: null,
      })
      .eq("project_id", project_id)
      .select("*").single();
    if (error) return err(error.message, 500);
    return ok(data);
  }

  // ── no action — write a new 'suggested' row from client-computed scores ──
  const { candidates, pages_evaluated, pages_agreeing, preview_page_id } = body;
  if (!Array.isArray(candidates) || !candidates.length)
    return err("candidates array required (ranked, highest score first)");
  if (!Number.isFinite(pages_evaluated) || !Number.isFinite(pages_agreeing))
    return err("pages_evaluated and pages_agreeing required");

  const winner = candidates[0];
  if (!winner.color || !Number.isFinite(winner.width) || !Number.isFinite(winner.score))
    return err("each candidate needs {color, width, score}");

  const row = {
    project_id,
    org_id: orgId,
    stroke_color: winner.color,
    stroke_width: winner.width,
    score: winner.score,
    runner_up_score: candidates[1]?.score ?? null,
    candidates,
    candidate_idx: 0,
    pages_evaluated,
    pages_agreeing,
    preview_page_id: preview_page_id ?? null,
    status: "suggested",
    confirmed_at: null,
  };

  const { data, error } = await supabase
    .from("wall_calibrations")
    .upsert(row, { onConflict: "project_id" })
    .select("*").single();
  if (error) return err(error.message, 500);
  return ok(data);
}

export const config = { path: "/api/pass-wall-calibrate" };
