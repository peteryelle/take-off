// netlify/functions/pass-a-legend.js
// Pass A — Legend Extraction (two-pass: discovery + per-column parallel extraction)
//
// Pass A1 — Discovery
//   Sends a tiny (0.3x) version of the legend to Claude.
//   Claude returns the x-boundary fractions for each section group.
//
// Pass A2 — Extraction
//   Crops the full-resolution image into vertical column strips using A1 boundaries.
//   Sends all strips to Claude in parallel.
//   Merges all device lists and writes to Supabase.
//
// POST { project_id, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { makeColumnStrips, resizeToBase64 } from "./utils/strips.js";

const DISCOVERY_SCALE = 0.3;   // tiny image for group boundary detection
const EXTRACT_QUALITY = 90;    // JPEG quality for column crops sent to Claude

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

  // ════════════════════════════════════════════════════════════════
  // PASS A1 — Discovery: find section group boundaries
  // ════════════════════════════════════════════════════════════════
  let tinyBase64;
  try {
    tinyBase64 = await resizeToBase64(page_image_base64, DISCOVERY_SCALE);
  } catch (e) {
    return err(`Image resize failed: ${e.message}`, 500);
  }

  const discoveryPrompt = `This is a legend page from an engineering drawing.
Identify every major section group or header text visible anywhere on this page.
Use the exact text you see in the image — do not use assumed or example names.
For each group found, estimate the horizontal x-position boundaries as fractions of the total image width.
  x_start = 0.0 means the left edge of the image.
  x_end   = 1.0 means the right edge of the image.
Groups should be non-overlapping and together span the full width (0.0 to 1.0).
If there are no clear section headers, treat the entire image as one group called "LEGEND".

Return ONLY valid JSON — no other text, no markdown fences:
{
  "groups": [
    { "group": "<exact header text from image>", "x_start": 0.0,  "x_end": 0.33 },
    { "group": "<exact header text from image>", "x_start": 0.33, "x_end": 0.66 },
    { "group": "<exact header text from image>", "x_start": 0.66, "x_end": 1.0  }
  ]
}`;

  let boundaries;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 512,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: tinyBase64 } },
          { type: "text", text: discoveryPrompt }
        ]
      }]
    });

    // Strip any accidental markdown fences before parsing
    const raw     = msg.content[0].text.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(raw);
    boundaries    = parsed.groups;
  } catch (e) {
    return err(`Discovery pass failed: ${e.message}`, 502);
  }

  if (!boundaries || boundaries.length === 0)
    return err("No legend groups detected in discovery pass", 422);

  // ════════════════════════════════════════════════════════════════
  // PASS A2 — Extraction: crop each group column and extract devices
  // ════════════════════════════════════════════════════════════════
  let columnStrips;
  try {
    columnStrips = await makeColumnStrips(page_image_base64, boundaries);
  } catch (e) {
    return err(`Column strip generation failed: ${e.message}`, 500);
  }

  const extractionPrompt = (groupName) =>
    `This image shows the "${groupName}" section of an engineering drawing legend.
Extract every device symbol shown. Include the group/sub-group name each device belongs to in its category field.

Rules:
- Capture every symbol, even if uncertain of its identity
- Description must be precise enough to distinguish this symbol from all others on a busy drawing
- Include: shape, fill color, border style, internal marks, typical size relative to drawing, label convention
- If two symbols look similar, note the distinguishing detail explicitly
- Do NOT invent devices not shown

Return ONLY valid JSON — no other text, no markdown fences:
{
  "devices": [
    {
      "legend_id": "DEV_001",
      "name": "string — concise device name",
      "description": "precise visual fingerprint",
      "category": "${groupName}",
      "discipline": "telecom|security|osp|general",
      "notes": "orientation variants, label conventions, or special notes"
    }
  ],
  "warnings": []
}
If no devices found: { "devices": [], "warnings": ["No devices found in this section"] }`;

  // Fire all column extractions in parallel
  const groupResults = await Promise.all(
    columnStrips.map(async (strip) => {
      try {
        const msg = await anthropic.messages.create({
          model:      "claude-sonnet-4-5",
          max_tokens: 2048,
          system:     SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: strip.base64 } },
              { type: "text", text: extractionPrompt(strip.group) }
            ]
          }]
        });
        const raw    = msg.content[0].text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(raw);
        return {
          group:    strip.group,
          devices:  parsed.devices  ?? [],
          warnings: parsed.warnings ?? []
        };
      } catch (e) {
        return {
          group:    strip.group,
          devices:  [],
          warnings: [`Group "${strip.group}" extraction error: ${e.message}`]
        };
      }
    })
  );

  // ── Merge all groups ──────────────────────────────────────────
  const allWarnings = [];
  const allDevices  = [];
  let   devCounter  = 1;

  for (const { group, devices, warnings } of groupResults) {
    allWarnings.push(...warnings);
    for (const d of devices) {
      // Ensure unique legend_id across groups by prefixing with counter if needed
      const legendId = d.legend_id && d.legend_id !== "DEV_001"
        ? d.legend_id
        : `DEV_${String(devCounter).padStart(3, "0")}`;
      allDevices.push({ ...d, legend_id: legendId, category: d.category || group });
      devCounter++;
    }
  }

  if (allDevices.length === 0)
    return err("No devices extracted from any legend group", 422);

  // ── Upsert device types into Supabase ────────────────────────
  const rows = allDevices.map(d => ({
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
    .select("id, legend_id, name, category");

  if (insertErr) return err(`DB error: ${insertErr.message}`, 500);

  return ok({
    pass:          "legend_extraction",
    project_id,
    project_name:  project.name,
    groups_found:  boundaries.length,
    groups:        boundaries.map(b => b.group),
    devices_found: inserted.length,
    warnings:      allWarnings,
    confidence:    "high",
    devices:       inserted
  });
}

export const config = { path: "/api/pass-a-legend" };
