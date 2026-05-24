// netlify/functions/pass-a-legend.js
// Pass A — Legend Extraction
// One call per uploaded column screenshot. No grouping. Just devices.
// POST { project_id, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_image_base64 } = body;
  if (!project_id || !page_image_base64)
    return err("project_id and page_image_base64 required");

  const supabase  = getSupabase();
  const anthropic = getAnthropic();

  // ── Verify project ────────────────────────────────────────────
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id, name").eq("id", project_id).single();
  if (projErr || !project) return err("Project not found", 404);

  // ── Single Claude call ────────────────────────────────────────
  const prompt = `This image is a section of an engineering drawing legend.
Extract every device symbol shown.

Rules:
- Capture every symbol shown — do not skip any
- Description must be precise enough to find this exact symbol on a busy drawing
- Include: shape, fill color, border style, any internal marks, typical size, label convention
- If two symbols look similar, explicitly note what distinguishes them
- Do NOT invent devices not visible in this image

Return ONLY valid JSON — no markdown, no extra text:
{
  "legend_found": true,
  "devices": [
    {
      "legend_id": "DEV_001",
      "name": "concise device name",
      "description": "precise visual fingerprint",
      "discipline": "telecom|security|osp|general",
      "notes": "label variants, orientation notes, or anything unusual"
    }
  ],
  "confidence": "high|medium|low",
  "warnings": []
}
If no devices found: { "legend_found": false, "devices": [], "confidence": "low", "warnings": ["No devices found"] }`;

  // Auto-detect image type from base64 prefix
  function detectMediaType(b64) {
    if (b64.startsWith("/9j/"))  return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    if (b64.startsWith("UklG"))  return "image/webp";
    if (b64.startsWith("R0lG"))  return "image/gif";
    return "image/png"; // safe default for Mac screenshots
  }
  const mediaType = detectMediaType(page_image_base64);

  let result;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: page_image_base64 } },
          { type: "text", text: prompt }
        ]
      }]
    });
    const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
    result    = JSON.parse(raw);
  } catch (e) {
    return err(`Anthropic error: ${e.message}`, 502);
  }

  if (!result.legend_found || !result.devices?.length)
    return err("No devices found in image", 422);

  // ── Upsert to Supabase ────────────────────────────────────────
  const rows = result.devices.map(d => ({
    project_id,
    legend_id:   d.legend_id,
    name:        d.name,
    description: d.description,
    category:    null,
    discipline:  d.discipline,
    notes:       d.notes ?? null
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from("device_types")
    .upsert(rows, { onConflict: "project_id,legend_id" })
    .select("id, legend_id, name");

  if (insertErr) return err(`DB error: ${insertErr.message}`, 500);

  return ok({
    pass:          "legend_extraction",
    project_id,
    devices_found: inserted.length,
    confidence:    result.confidence,
    warnings:      result.warnings ?? [],
    devices:       inserted
  });
}

export const config = { path: "/api/pass-a-legend" };
