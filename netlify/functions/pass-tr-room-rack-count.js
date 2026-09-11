// netlify/functions/pass-tr-room-rack-count.js
// Replaces pass-tr-room-vision.js entirely -- no Anthropic vision call. The
// client (tr-room-review.html) extracts rack-callout text anchors and
// stroke-vector segments directly via pdf.js (same page it already has
// loaded for cropping/naming), and this function just runs the real,
// validated leader-fan tracer against them.
//
// Why this replaced vision: leader-fan tracing on real vector geometry was
// proven this session (6/9 real rooms exact, 3 correctly flagged, zero
// confidently-wrong answers -- see count-leadered-devices.js's own header)
// and end-to-end tested against this exact production pdf.js version
// (3.11.174) before this function was written -- FB28L-1: fanout 2, matching
// its true rack count, using real anchor+segment extraction, not a mock.
//
// POST { project_id, page_id, tr_number, anchors, segments }
//   anchors:  [[x,y], ...]  one per rack-callout text anchor found in this
//     room's coded-notes region, in the SAME raw pdf.js coordinate space as
//     segments (native PDF space, NOT the normalized 0-1 space used
//     elsewhere in this page for cropping -- see this function's own
//     validation notes on count-leadered-devices.js for why that distinction
//     matters).
//   segments: [[[x1,y1],[x2,y2]], ...]  stroke-vector line segments from the
//     SAME page, via geometry.js's extractStrokeSubpaths (or equivalent),
//     flattened into consecutive point-pairs.
//   codedNotes: [{number, text}]  this sheet's own parsed coded notes, used
//     to set each detection's category via categorize-coded-note.js, same
//     as every anchor's category is set elsewhere in this pipeline.

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg, assertProjectUnlocked } from "./utils/auth.js";
import { countLeaderedDevices } from "../../public/lib/count-leadered-devices.js";
import { categorizeCodedNote } from "../../public/lib/categorize-coded-note.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, tr_number, anchors, segments, codedNotes, page_width, page_height } = body;
  if (!project_id || !page_id || !tr_number || !Array.isArray(anchors) || !Array.isArray(segments) || !page_width || !page_height)
    return err("project_id, page_id, tr_number, anchors[], segments[], page_width, page_height required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-running.", 423);

  // Each anchor carries its own coded-note number (client tags which anchor
  // came from which callout) so results can be individually attributed and
  // categorized -- matching {anchor, coded_note_number} pairs, not a bare
  // coordinate list, since a room can have more than one rack callout
  // (confirmed real case: EB51A-1 has two, summing to its true count of 3).
  const anchorCoords = anchors.map((a) => a.xy ?? a);
  const result = countLeaderedDevices(anchorCoords, segments);

  const notesByNumber = new Map((codedNotes ?? []).map((n) => [n.number, n.text]));

  // Always-overwrite for this room's leader_fan-sourced rows on re-run, same
  // convention as the vision pass it replaces -- manual corrections
  // (source:'manual') are untouched.
  const { error: delErr } = await supabase
    .from("tr_room_devices").delete()
    .eq("page_id", page_id).eq("tr_number", tr_number).eq("source", "leader_fan");
  if (delErr) return err(`tr_room_devices delete failed: ${delErr.message}`, 500);

  const rows = result.perAnchor.flatMap((r, i) => {
    if (!r.ok) return []; // flagged anchors are NOT written as devices -- a
      // human reviews these via unresolvedAnchors, never a silent count.
    const codedNoteNumber = anchors[i]?.coded_note_number ?? null;
    const noteText = notesByNumber.get(codedNoteNumber) ?? null;
    const { category } = noteText ? categorizeCodedNote(noteText) : { category: null };
    // fanout devices share one origin point; spread them slightly around it
    // for the confidence-map UI rather than stacking identical coordinates.
    // Origin comes back in raw pdf.js PDF-point space (the space the leader-
    // fan math actually needs to work against real vector geometry) --
    // normalized here to 0-1 before storage, since x_norm/y_norm elsewhere
    // in this table (every manually-added device) are 0-1 fractions of the
    // page, not raw points. Storing raw values here would have silently
    // broken marker rendering and been inconsistent with every other row.
    return Array.from({ length: r.fanout }, (_, k) => ({
      org_id: orgId, project_id, page_id, tr_number,
      coded_note_number: codedNoteNumber, coded_note_text: noteText, category,
      x_norm: r.origin[0] / page_width, y_norm: 1 - (r.origin[1] / page_height),
      confidence: "high", source: "leader_fan",
    }));
  });

  if (rows.length) {
    const { error: insErr } = await supabase.from("tr_room_devices").insert(rows);
    if (insErr) return err(`tr_room_devices insert failed: ${insErr.message}`, 500);
  }

  return ok({
    tr_number,
    devices_found: rows.length,
    needsReview: result.needsReview,
    unresolvedAnchors: result.unresolvedAnchors,
    devices: rows,
  });
}

export const config = { path: "/api/pass-tr-room-rack-count" };
