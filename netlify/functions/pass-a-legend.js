// netlify/functions/pass-a-legend.js
// Pass A — Legend Extraction
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

  const supabase   = getSupabase();
  const anthropic  = getAnthropic();

  // ── Verify project exists ─────────────────────────────────────
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id, name").eq("id", project_id).single();
  if (projErr || !project) return err("Project not found", 404);

  // ── Call Anthropic vision ─────────────────────────────────────
  const prompt = `Analyze this legend page and extract every device symbol shown.
Return JSON matching this exact schema — no other text:
{
  "pass": "legend_extraction",
  "legend_found": true,
  "devices": [
    {
      "legend_id": "DEV_001",
      "name": "string",
      "description": "precise visual fingerprint",
      "category": "string",
      "discipline": "telecom|security|osp",
      "notes": "string"
    }
  ],
  "demarcation_in_legend": { "found": false, "description": "" },
  "confidence": "high|medium|low",
  "warnings": []
}`;

  let legendResult;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: page_image_base64 } },
          { type: "text", text: prompt }
        ]
      }]
    });
    legendResult = JSON.parse(msg.content[0].text);
  } catch (e) {
    return err(`Anthropic error: ${e.message}`, 502);
  }

  if (!legendResult.legend_found) return err("Legend not found in image", 422);

  // ── Upsert device types into Supabase ────────────────────────
  const rows = legendResult.devices.map(d => ({
    project_id,
    legend_id:   d.legend_id,
    name:        d.name,
    description: d.description,
    category:    d.category,
    discipline:  d.discipline,
    notes:       d.notes ?? null
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from("device_types")
    .upsert(rows, { onConflict: "project_id,legend_id" })
    .select("id, legend_id, name");

  if (insertErr) return err(`DB error: ${insertErr.message}`, 500);

  return ok({
    pass:            "legend_extraction",
    project_id,
    devices_found:   inserted.length,
    warnings:        legendResult.warnings ?? [],
    confidence:      legendResult.confidence,
    devices:         inserted
  });
}

export const config = { path: "/api/pass-a-legend" };
