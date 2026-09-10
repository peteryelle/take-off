// netlify/functions/pass-tr-room-vision.js
// Vision-based device detection for ONE enlarged TR room drawing (T-401
// series). POST { project_id, page_id, tr_number, room_image_base64, coded_notes }
//
// Why vision, not text/vector analysis: both were tried and both failed on
// real data (see tr-schedule.js's sibling investigation this session). A
// single numbered leader-line callout can reference a CLUSTER of multiple
// racks with zero distinguishing text — confirmed on a real sheet, EB51A-1
// has 3 racks and exactly 1 "②" callout. Neither text extraction nor raw
// vector-line heuristics (tried: length/angle filtering on leader arrows —
// architectural hatching produces near-identical diagonal segments) can
// recover that count. A vision read can, the same way a human looking at the
// drawing does: by actually counting the drawn rack icons, not the labels.
//
// coded_notes ({number, text}[], from parse-coded-notes.js) is passed in
// rather than re-derived here, so the prompt can tell Claude exactly what
// each sheet-local number means on THIS sheet — coded-note numbering is not
// a stable convention across sheets (see parse-coded-notes.js's file header).
//
// Every detection this returns is a PROPOSAL, not a final count. It gets
// written with source:'vision' and a confidence level; the confidence-map-
// style UI is where a human adds/removes to correct it — same "brittleness
// triggers the human" reflex as everything else in this pipeline, not a
// silent replacement for review.

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg, assertProjectUnlocked } from "./utils/auth.js";
import { categorizeCodedNote } from "../../public/lib/categorize-coded-note.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, tr_number, room_image_base64, coded_notes } = body;
  if (!project_id || !page_id || !tr_number || !room_image_base64 || !Array.isArray(coded_notes))
    return err("project_id, page_id, tr_number, room_image_base64 and coded_notes[] required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-running.", 423);
  const anthropic = getAnthropic();

  const notesList = coded_notes.map((n) => `${n.number}: ${n.text}`).join("\n");

  const prompt = `This image is one enlarged telecommunications room (TR) floor plan, cropped from a larger architectural sheet. Room identifier: ${tr_number}.

This sheet's coded notes (numbered leader-line callouts on the drawing refer to these):
${notesList}

Find every physical device or piece of equipment actually drawn in this room that corresponds to one of the coded notes above, OR a directly-labeled symbol on the drawing (letter codes like CP, DC, RE, A — card reader, door contact, request-to-exit, camera).

CRITICAL — a single numbered callout can reference MORE THAN ONE physical item, with no separate numbering to distinguish them:
- A "②" leader-line label pointing into a room does not mean exactly one item. If that room's wall shows three separate rack-elevation rectangles drawn side by side, that is three racks, even though only one "②" bubble is drawn.
- Count what is actually DRAWN (each distinct rack rectangle, each distinct symbol icon), not how many numbered labels appear.
- If several coded notes share one leader line fanning out to multiple endpoints, report one device per endpoint, all citing that same coded note number.

Do not guess a count you can't actually see. If a room's equipment is genuinely ambiguous (e.g. hatching obscures whether there are 2 or 3 racks), report your best count at "medium" or "low" confidence rather than skip it — a human reviews every detection before it's final.

Return ONLY valid JSON — no markdown, no extra text:
{
  "devices": [
    { "coded_note_number": 2, "x_norm": 0.42, "y_norm": 0.61, "confidence": "high" }
  ],
  "warnings": []
}
If no devices found: { "devices": [], "warnings": ["no matching devices found in this crop"] }`;

  function detectMediaType(b64) {
    if (b64.startsWith("/9j/"))  return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    if (b64.startsWith("UklG"))  return "image/webp";
    if (b64.startsWith("R0lG"))  return "image/gif";
    return "image/png";
  }
  const mediaType = detectMediaType(room_image_base64);

  let result;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: room_image_base64 } },
          { type: "text", text: prompt }
        ]
      }]
    });
    const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
    result    = JSON.parse(raw);
  } catch (e) {
    return err(`Anthropic error: ${e.message}`, 502);
  }

  const notesByNumber = new Map(coded_notes.map((n) => [n.number, n.text]));

  // Always-overwrite semantics for this room, same convention as
  // tr_schedule_rows and the device-library sync -- a re-run replaces this
  // room's vision-sourced proposals rather than accumulating duplicates.
  // Manually added devices (source:'manual') are never touched by this --
  // a human's own additions/corrections shouldn't be wiped by a re-run.
  const { error: delErr } = await supabase
    .from("tr_room_devices").delete()
    .eq("page_id", page_id).eq("tr_number", tr_number).eq("source", "vision");
  if (delErr) return err(`tr_room_devices delete failed: ${delErr.message}`, 500);

  const rows = (result.devices ?? []).map((d) => {
    const noteText = notesByNumber.get(d.coded_note_number) ?? null;
    const { category } = noteText ? categorizeCodedNote(noteText) : { category: null };
    return {
      org_id: orgId,
      project_id,
      page_id,
      tr_number,
      coded_note_number: d.coded_note_number ?? null,
      coded_note_text: noteText,
      category,
      x_norm: d.x_norm,
      y_norm: d.y_norm,
      confidence: d.confidence ?? "medium",
      source: "vision",
    };
  });

  if (rows.length) {
    const { error: insErr } = await supabase.from("tr_room_devices").insert(rows);
    if (insErr) return err(`tr_room_devices insert failed: ${insErr.message}`, 500);
  }

  return ok({
    tr_number,
    devices_found: rows.length,
    warnings: result.warnings ?? [],
    devices: rows,
  });
}

export const config = { path: "/api/pass-tr-room-vision" };
