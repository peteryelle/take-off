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
// read text_items -> parseTrSchedule (public/lib/tr-schedule.js) -> return
// the proposed rows. That's the whole pass now.
//
// HITL note: this endpoint used to delete+insert tr_schedule_rows directly,
// with no human ever seeing a row before it landed. It no longer writes
// anything -- it only proposes. tr-schedule-review.html calls this to get
// the parse, lets a human edit/confirm each row, then POSTs the (possibly
// edited) rows to confirm-tr-schedule.js, which does the actual write and
// sets confirmed = true. This mirrors tr-room-review.html's existing
// propose -> human review -> confirm pattern for rack counts -- T-500 was
// the one step in this pipeline skipping that pattern entirely, silently
// overwriting tr_schedule_rows on every batch re-run.

import { ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
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
  // No lock check here — a lock guards writes that change counts, and this
  // endpoint no longer writes anything. Re-proposing a parse for review is
  // always safe, locked project or not.

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

    // Nothing is written to tr_schedule_rows here — see file header. Status
    // settles on pending_review, not done: a human hasn't looked at this
    // parse yet, and confirm-tr-schedule.js is what advances it to done.
    await supabase.from("pages").update({ status: "pending_review", status_msg: null }).eq("id", page_id);
    return ok({ tr_count: rows.length, rows });

  } catch (e) {
    await supabase.from("pages").update({ status: "error", status_msg: e.message }).eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/pass-tr-schedule" };
