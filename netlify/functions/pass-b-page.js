// netlify/functions/pass-b-page.js
// Pass B — Scale + Demarcation Detection
// POST { project_id, pdf_page_number, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { makeStrips, toFullCoords } from "./utils/strips.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, pdf_page_number, page_image_base64 } = body;
  if (!project_id || !pdf_page_number || !page_image_base64)
    return err("project_id, pdf_page_number and page_image_base64 required");

  const supabase  = getSupabase();
  const anthropic = getAnthropic();

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

  let msgText;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: page_image_base64 } },
          { type: "text", text: prompt }
        ]
      }]
    });
    msgText = msg.content[0].text;
  } catch (e) {
    return err(`Anthropic error: ${e.message}`, 502);
  }

  // ── Parse response ────────────────────────────────────────────
  let result;
  try {
    const raw = msgText.replace(/```json|```/g, "").trim();
    result = JSON.parse(raw);
  } catch (e) {
    return err(`JSON parse error: ${e.message} — raw: ${msgText.slice(0, 200)}`, 502);
  }

  // ── Strip-based demarc location ─────────────────────────────────────
  // If demarc was found (label identified) but coordinates are still missing,
  // slice the page into strips and scan each one for the TR room label.
  // Strips are zoomed-in relative to the full page — small room labels
  // that are invisible at 0.6 scale become readable in a narrow strip.
  if (result.demarcation?.found && (result.demarcation.x == null || result.demarcation.y == null)) {
    const trLabel = (result.demarcation.label ?? '').trim();
    if (trLabel) {
      try {
        const N_STRIPS = 8;
        const strips   = await makeStrips(page_image_base64, N_STRIPS);

        const stripPrompt = (strip, label) =>
`You are scanning strip ${strip.index + 1} of ${N_STRIPS} (y=${strip.y_norm_start.toFixed(3)}–${strip.y_norm_end.toFixed(3)}) of an engineering floor plan.

Find the telecommunications room labeled "${label}". It may appear as:
- A room box with text like "TR ${label}", "IDF ${label}", "PBX ROOM ${label}", "TELECOM ${label}", or just "${label}" with a square footage
- A small labeled rectangle or enclosed space

Return ONLY valid JSON — no markdown:
{
  "found": false,
  "x_frac": null,
  "y_frac_in_strip": null,
  "description": "what you see"
}
x_frac and y_frac_in_strip are 0-1 relative to THIS STRIP.
If the room is not visible in this strip: set found to false and x_frac/y_frac_in_strip to null.`;

        let located = false;
        for (const strip of strips) {
          try {
            const msg = await anthropic.messages.create({
              model:      "claude-sonnet-4-5",
              max_tokens: 256,
              messages: [{
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", media_type: mediaType, data: strip.base64 } },
                  { type: "text", text: stripPrompt(strip, trLabel) }
                ]
              }]
            });
            const raw    = msg.content[0].text.replace(/```json|```/g, "").trim();
            const parsed = JSON.parse(raw);

            if (parsed.found && parsed.x_frac != null && parsed.y_frac_in_strip != null) {
              const coords = toFullCoords(strip, parsed.x_frac, parsed.y_frac_in_strip);
              result.demarcation.x          = parseFloat(coords.x.toFixed(3));
              result.demarcation.y          = parseFloat(coords.y.toFixed(3));
              result.demarcation.is_host    = true;
              result.demarcation.type       = result.demarcation.type === "off_sheet"
                                              ? "IDF" : (result.demarcation.type ?? "IDF");
              result.demarcation.description = parsed.description;
              result.warnings = result.warnings ?? [];
              result.warnings.push(
                `TR room ${trLabel} located via strip ${strip.index + 1} at (${coords.x.toFixed(3)}, ${coords.y.toFixed(3)})`
              );
              located = true;
              break; // stop scanning once found
            }
          } catch { /* skip failed strip */ }
        }

        if (!located) {
          result.warnings = result.warnings ?? [];
          result.warnings.push(`TR room ${trLabel} not found in any of ${N_STRIPS} strips — may be on a different sheet`);
        }
      } catch(e) {
        result.warnings = result.warnings ?? [];
        result.warnings.push(`Strip scan failed: ${e.message}`);
      }
    }
  }

  const isHost    = result.demarcation?.found && result.demarcation?.is_host === true;
  const isOffSheet = result.demarcation?.found && !isHost;

  // ── Upsert page record ────────────────────────────────────────
  const pageRow = {
    project_id,
    pdf_page_number,
    drawing_number:  result.drawing_number  ?? null,
    sheet_title:     result.sheet_title     ?? null,
    building:        result.building        ?? null,
    level:           result.level           ?? null,
    area:            result.area            ?? null,
    scale_label:     result.scale?.display_label       ?? null,
    scale_paper_in:  result.scale?.text?.paper_value   ?? null,
    scale_real_ft:   result.scale?.text?.real_value    ?? null,
    demarc_label:    result.demarcation?.label         ?? null,
    demarc_type:     isHost       ? result.demarcation.type : "off_sheet",
    demarc_x:        isHost       ? result.demarcation.x   : null,
    demarc_y:        isHost       ? result.demarcation.y   : null,
    demarc_is_host:  isHost,
    demarc_source:   isHost       ? "claude"               : "off_sheet",
    drawing_x0:      result.drawing_bounds?.x0 ?? null,
    drawing_y0:      result.drawing_bounds?.y0 ?? null,
    drawing_x1:      result.drawing_bounds?.x1 ?? null,
    drawing_y1:      result.drawing_bounds?.y1 ?? null,
    pass_b_complete: true
  };

  const { data: page, error: pageErr } = await supabase
    .from("pages")
    .upsert(pageRow, { onConflict: "project_id,pdf_page_number" })
    .select("id")
    .single();

  if (pageErr) return err(`DB error: ${pageErr.message}`, 500);

  return ok({
    pass:           "scale_and_demarc",
    page_id:        page.id,
    sheet_title:    result.sheet_title,
    scale:          result.scale,
    demarcation:    result.demarcation,   // includes is_host for pass-scan.js to consume
    drawing_bounds: result.drawing_bounds ?? null,
    warnings:       result.warnings ?? []
  });
}

export const config = { path: "/api/pass-b-page" };
