// netlify/functions/pass-b-page.js
// Pass B — Scale + Demarcation Detection
// POST { project_id, pdf_page_number, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";

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
    "x": null,
    "y": null,
    "description": "string or null",
    "confidence": "low"
  },
  "warnings": []
}

Rules:
- Coordinates x,y are normalized 0-1 (x=0 left, x=1 right, y=0 top, y=1 bottom)
- If scale not found set type to "none"
- If demarcation is on a different sheet set found=false and type="off_sheet"
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
    demarc_type:     result.demarcation?.found ? result.demarcation.type : "off_sheet",
    demarc_x:        result.demarcation?.found ? result.demarcation.x   : null,
    demarc_y:        result.demarcation?.found ? result.demarcation.y   : null,
    demarc_source:   result.demarcation?.found ? "claude" : "off_sheet",
    pass_b_complete: true
  };

  const { data: page, error: pageErr } = await supabase
    .from("pages")
    .upsert(pageRow, { onConflict: "project_id,pdf_page_number" })
    .select("id")
    .single();

  if (pageErr) return err(`DB error: ${pageErr.message}`, 500);

  return ok({
    pass:        "scale_and_demarc",
    page_id:     page.id,
    sheet_title: result.sheet_title,
    scale:       result.scale,
    demarcation: result.demarcation,
    warnings:    result.warnings ?? []
  });
}

export const config = { path: "/api/pass-b-page" };
