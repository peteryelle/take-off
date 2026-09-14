// netlify/functions/confirm-tr-schedule.js
// The human-confirm half of the T-500 HITL split (see pass-tr-schedule.js's
// header for the full propose/confirm story). This is the ONLY place that
// writes tr_schedule_rows now — pass-tr-schedule.js only proposes.
//
// POST /api/confirm-tr-schedule
// Body: { project_id, page_id, rows }
//   rows: [{ tr_number, building?, level?, total_terminations, min_patch_panels }]
//   — normally pass-tr-schedule.js's own proposed rows, verbatim or edited
//   by the human in tr-schedule-review.html (cell edits, deleted rows,
//   manually-added rows for a locator/column-count mismatch case like this
//   project's TBD rows). This endpoint does not re-parse or re-derive
//   anything from a PDF — it trusts the caller's rows exactly as sent,
//   because the human has already looked at them. That's the point of the
//   split: pass-tr-schedule.js's job is proposing a parse, this endpoint's
//   job is committing what a human has actually reviewed.
//
// Same always-overwrite-per-page semantics the old combined endpoint had
// (delete this page's rows, insert the confirmed set) -- a re-confirm after
// further edits replaces, not accumulates.

import { ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg, assertProjectUnlocked } from "./utils/auth.js";

function normNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, rows } = body;
  if (!project_id || !page_id || !Array.isArray(rows))
    return err("project_id, page_id and rows[] required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  // This DOES write, so the project-lock gate applies here, unlike the
  // propose endpoint -- confirming a schedule after a project's final run
  // was accepted would silently change counts behind that acceptance.
  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-confirming.", 423);

  // Validate every row before writing any of them -- a partial commit on a
  // bad row would leave this page's tr_schedule_rows in a worse state
  // (some confirmed, some silently missing) than not committing at all.
  const clean = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const tr_number = String(r.tr_number ?? "").trim();
    const total_terminations = normNum(r.total_terminations);
    const min_patch_panels = normNum(r.min_patch_panels);
    if (!tr_number) return err(`row ${i + 1}: tr_number is required`, 422);
    if (total_terminations == null) return err(`row ${i + 1} (${tr_number}): total_terminations must be a number`, 422);
    if (min_patch_panels == null) return err(`row ${i + 1} (${tr_number}): min_patch_panels must be a number`, 422);
    clean.push({
      tr_number,
      building: r.building != null && r.building !== "" ? String(r.building).trim() : null,
      level: r.level != null && r.level !== "" ? String(r.level).trim() : null,
      total_terminations,
      min_patch_panels,
    });
  }

  try {
    const { error: delErr } = await supabase.from("tr_schedule_rows").delete().eq("page_id", page_id);
    if (delErr) throw new Error(`tr_schedule_rows delete failed: ${delErr.message}`);

    const now = new Date().toISOString();
    if (clean.length) {
      const { error: insErr } = await supabase.from("tr_schedule_rows").insert(
        clean.map((r) => ({
          org_id: orgId,
          project_id,
          page_id,
          tr_number: r.tr_number,
          building: r.building,
          level: r.level,
          total_terminations: r.total_terminations,
          min_patch_panels: r.min_patch_panels,
          confirmed: true,
          confirmed_at: now,
        }))
      );
      if (insErr) throw new Error(`tr_schedule_rows insert failed: ${insErr.message}`);
    }

    await supabase.from("pages").update({ status: "done", status_msg: null }).eq("id", page_id);
    return ok({ confirmed_count: clean.length, rows: clean });

  } catch (e) {
    await supabase.from("pages").update({ status: "error", status_msg: e.message }).eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/confirm-tr-schedule" };
