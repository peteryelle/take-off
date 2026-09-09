// netlify/functions/pass-tr-schedule.js
// Dedicated pass for TR (telecom room) schedule pages — e.g. T-500's
// "TELECOMMUNICATION ROOM TERMINATION AND HARDWARE SCHEDULE."
//
// Deliberately NOT pass-batch.js. That endpoint's scale gate, drawing-bounds
// filter, symbol detection, and wall-aware routing all exist to place and
// measure individual devices — none of which this table has. A TR schedule
// row has no UIN, no x/y, nothing to route to a demarc pin. Forcing it
// through pass-batch.js means it 422s on "scale not set" every time,
// regardless of role, because that gate has no page_role branch (confirmed
// by reading it — this is the bug that motivated a separate endpoint rather
// than patching an exemption into a gate that's correct for its actual job).
//
// POST /api/pass-tr-schedule
// Body: { project_id, page_id, text_items }
//
// read text_items -> parseTrSchedule (public/lib/tr-schedule.js) -> replace
// this page's rows in tr_schedule_rows. That's the whole pass.

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg, assertProjectUnlocked } from "./utils/auth.js";
import { parseTrSchedule } from "../../public/lib/tr-schedule.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, text_items } = body;
  if (!project_id || !page_id || !text_items?.length)
    return err("project_id, page_id and text_items required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-running.", 423);

  await supabase.from("pages").update({ status: "running", status_msg: null }).eq("id", page_id);

  try {
    const { data: page } = await supabase
      .from("pages").select("id, tr_schedule").eq("id", page_id).single();
    if (!page) return err("Page not found", 404);

    if (!page.tr_schedule || page.tr_schedule.present === false) {
      const msg = "No tr_schedule config on this page — set pages.tr_schedule (locator + columns) before running this pass";
      await supabase.from("pages").update({ status: "error", status_msg: msg }).eq("id", page_id);
      return err(msg, 422);
    }

    const rows = parseTrSchedule(text_items, page.tr_schedule);

    // TEMPORARY diagnostic (remove once the real-browser-extraction shape is
    // confirmed): 0 rows against real production text_items, despite the
    // exact same locator/columns/tolerances working on a Python-extracted
    // fixture, points at a normalization-shape mismatch (multi-page.html
    // normalizes cx_norm/cy_norm relative to a trimmed content frame with a
    // Y-flip; the fixture used plain full-page-fraction). Capture what this
    // pass actually received so that can be confirmed from Supabase directly,
    // no DevTools round-trip needed.
    let diag = null;
    if (rows.length === 0) {
      const xs = text_items.map((t) => t.cx_norm);
      const ys = text_items.map((t) => t.cy_norm);
      diag = {
        item_count: text_items.length,
        cx_range: [Math.min(...xs), Math.max(...xs)],
        cy_range: [Math.min(...ys), Math.max(...ys)],
        sample: text_items.slice(0, 15),
        tr_schedule_cfg: page.tr_schedule,
      };
    }

    // Always-overwrite semantics for this page — same convention as the
    // device-library sync (legend_id-keyed), not an append. A re-run after a
    // config fix should replace, not accumulate duplicate TR rows.
    const { error: delErr } = await supabase.from("tr_schedule_rows").delete().eq("page_id", page_id);
    if (delErr) throw new Error(`tr_schedule_rows delete failed: ${delErr.message}`);

    if (rows.length) {
      const { error: insErr } = await supabase.from("tr_schedule_rows").insert(
        rows.map((r) => ({
          org_id: orgId,
          project_id,
          page_id,
          tr_number: r.tr_number,
          building: r.building,
          level: r.level,
          total_terminations: r.total_terminations,
          min_patch_panels: r.min_patch_panels,
        }))
      );
      if (insErr) throw new Error(`tr_schedule_rows insert failed: ${insErr.message}`);
    }

    await supabase.from("pages").update({
      status: "done",
      status_msg: diag ? JSON.stringify(diag) : null,
    }).eq("id", page_id);
    return ok({ tr_count: rows.length, rows, diag });

  } catch (e) {
    await supabase.from("pages").update({ status: "error", status_msg: e.message }).eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/pass-tr-schedule" };
