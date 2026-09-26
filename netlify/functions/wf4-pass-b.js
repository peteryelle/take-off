// netlify/functions/wf4-pass-b.js
// WF4 copy of pass-b-page.js — Pass B: scale, drawing area and TR detection
// for one plan page. METERED (one model call per page) — it just runs; token
// use and cost are logged per page for the admin page (utils/metered.js).
//
// POST /api/wf/wf4/pass-b   { project_id, page_id, page_image_base64 }
//
// Changes from pass-b-page.js (prompt, model and parsing unchanged):
//   * v2 page by page_id (the page already exists from intake).
//   * Writes scale (+ pts/ft, same formula as the batch override) and drawing
//     bounds to takeoff.pages. Sheet title / building / level are only filled
//     where intake's title-block reader left them empty — never overwritten.
//   * The TR found is RETURNED, not saved: the TR pins stage places it.
//   * Same image again (re-run, duplicate sheet, unchanged revision) reuses
//     the stored result with no model call (utils/pass-reuse.js).
// ─────────────────────────────────────────────────────────────────

import { getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { requireOrg } from "./utils/auth.js";
import { td, assertWfProjectInOrg } from "./utils/takeoff-db.js";
import { meteredCreate } from "./utils/metered.js";
import { sha256, variantKey, findStored, saveStored, logReuse } from "./utils/pass-reuse.js";

const MODEL = "claude-sonnet-4-5";
const PROMPT_VERSION = "pass_b.v1";   // bump when the prompt changes, so stored results aren't reused
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, page_image_base64 } = body;
  if (!project_id || !page_id || !page_image_base64)
    return err("project_id, page_id and page_image_base64 required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (!(await assertWfProjectInOrg(supabase, project_id, orgId))) return err("Project not found", 404);
  const { data: pageRow0 } = await db.from("pages").select("id, project_id, title_text, building, level").eq("id", page_id).maybeSingle();
  if (!pageRow0 || String(pageRow0.project_id) !== String(project_id)) return err("Page not found in this project", 404);

  // ── Detect image type ─────────────────────────────────────────
  function detectMediaType(b64) {
    if (b64.startsWith("/9j/"))  return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    if (b64.startsWith("UklG"))  return "image/webp";
    return "image/jpeg";
  }
  const mediaType = detectMediaType(page_image_base64);

  // ── Call Anthropic vision ─────────────────────────────────────
  const prompt = `Analyze this engineering drawing page and return ONLY valid JSON with no markdown, no code fences, no extra text.

Return exactly this structure:
{
  "pass": "scale_and_demarc",
  "sheet_title": "string or null",
  "sheet_title_confidence": "high|medium|low|not_found",
  "drawing_number": "string or null",
  "building": "string or null",
  "level": "string or null",
  "area": "string or null",
  "scale": {
    "type": "text|graphic|both|none",
    "text": { "paper_value": 0.125, "paper_unit": "in", "real_value": 1, "real_unit": "ft" },
    "display_label": "1/8\\" = 1\\'-0\\"",
    "confidence": "high|medium|low",
    "notes": ""
  },
  "demarcation": {
    "found": false,
    "label": "string or null",
    "type": "MDF|IDF|NID|handhole|panel|backboard|off_sheet|other",
    "is_host": false,
    "x": null,
    "y": null,
    "description": "string or null",
    "confidence": "low"
  },
  "drawing_bounds": {
    "x0": 0.0,
    "y0": 0.0,
    "x1": 0.65,
    "y1": 0.85,
    "confidence": "high|medium|low",
    "notes": "floor plan occupies left portion, notes columns on right"
  },
  "warnings": []
}

Rules:
- Coordinates x,y are normalized 0-1 (x=0 left, x=1 right, y=0 top, y=1 bottom)
- If scale not found set type to "none"
- drawing_bounds: identify the bounding box of the actual floor plan drawing area only — exclude notes columns, title block, key plan, legend boxes, and general notes text. This is the region containing walls, rooms, and device symbols.

Demarcation rules:
- found: set to true if a TR/telecom room is either physically drawn on this page OR referenced as serving this floor.
- label: the TR room identifier (e.g. "BT03", "SL06", "TR G20"). Extract from the room label or from service notes like "DATA OUTLETS SHALL BE SERVED FROM TELECOMMUNICATIONS ROOM SL06".
- is_host: set to TRUE only if the TR room boundary is physically drawn on this page as a labeled room polygon or enclosed space on the floor plan (e.g. a room box labeled "BT03" or "TELECOM ROOM"). Set to FALSE if the TR room is only mentioned in a general note, keynote, or annotation such as "DEVICES IN THIS AREA SHALL BE SERVED FROM TR BT03 ON LEVEL 00B" without a physical room being shown on this page. This field is critical — it determines which page the TR room actually lives on.
- type: use "off_sheet" when is_host is false (TR is on a different floor/sheet). Use "IDF", "MDF", etc. when is_host is true.
- x, y: provide coordinates only when is_host is true (the physical room location on this page). Set to null when is_host is false.
- Return ONLY the JSON object, nothing else`;

  const ctx = { supabase, orgId, projectId: project_id, pageId: page_id, pass: "pass_b", detail: null, userId: user?.id };
  const reuseKey = { orgId, pass: "pass_b", inputHash: sha256(page_image_base64), variant: variantKey([PROMPT_VERSION, MODEL]) };

  let result = await findStored(supabase, reuseKey);
  const reused = !!result;
  if (reused) {
    await logReuse(supabase, ctx, MODEL);
  } else {
    let msgText;
    try {
      const msg = await meteredCreate(getAnthropic(), {
        model:      MODEL,
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: page_image_base64 } },
            { type: "text", text: prompt }
          ]
        }]
      }, ctx);
      msgText = msg.content[0].text;
    } catch (e) {
      return err(`Anthropic error: ${e.message}`, 502);
    }

    // ── Parse response ──────────────────────────────────────────
    try {
      const raw = msgText.replace(/```json|```/g, "").trim();
      result = JSON.parse(raw);
    } catch (e) {
      return err(`JSON parse error: ${e.message} — raw: ${msgText.slice(0, 200)}`, 502);
    }
    await saveStored(supabase, { ...reuseKey, result, pageId: page_id });
  }

  const isHost    = result.demarcation?.found && result.demarcation?.is_host === true;

  // ── Update the v2 page ────────────────────────────────────────
  const paper = result.scale?.text?.paper_value, real = result.scale?.text?.real_value;
  const scaleOk = Number.isFinite(paper) && Number.isFinite(real) && real > 0 && paper > 0;
  const pageUpdate = {
    scale_label:      result.scale?.display_label ?? null,
    scale_paper_in:   scaleOk ? paper : null,
    scale_real_ft:    scaleOk ? real  : null,
    scale_pts_per_ft: scaleOk ? (72 * paper) / real : null,   // same formula as the batch scale override
    drawing_x0:       result.drawing_bounds?.x0 ?? null,
    drawing_y0:       result.drawing_bounds?.y0 ?? null,
    drawing_x1:       result.drawing_bounds?.x1 ?? null,
    drawing_y1:       result.drawing_bounds?.y1 ?? null,
  };
  // Intake's title-block reader is authoritative — only fill what it left empty.
  if (!pageRow0.title_text && result.sheet_title) pageUpdate.title_text = result.sheet_title;
  if (!pageRow0.building && result.building)      pageUpdate.building = result.building;
  if (!pageRow0.level && result.level)            pageUpdate.level = result.level;

  const { error: pageErr } = await db.from("pages").update(pageUpdate).eq("id", page_id);
  if (pageErr) return err(`DB error: ${pageErr.message}`, 500);

  return ok({
    pass:           "scale_and_demarc",
    page_id:        Number(page_id),
    reused,
    tr_suggestion:  result.demarcation?.found
      ? { tr_name: result.demarcation.label ?? null, on_this_sheet: !!isHost,
          x_norm: isHost ? result.demarcation.x ?? null : null, y_norm: isHost ? result.demarcation.y ?? null : null }
      : null,
    sheet_title:    result.sheet_title,
    scale:          result.scale,
    demarcation:    result.demarcation,   // includes is_host for pass-scan.js to consume
    drawing_bounds: result.drawing_bounds ?? null,
    warnings:       result.warnings ?? []
  });
}

export const config = { path: "/api/wf/wf4/pass-b" };
