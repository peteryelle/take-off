// netlify/functions/pass-b2-scan.js
// Pass B2 — Device Pre-Scan
// Sends the full page at low-res + full device list to Claude.
// Claude returns which device types are actually visible on this page.
// POST { project_id, page_id, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, page_image_base64 } = body;
  if (!project_id || !page_id || !page_image_base64)
    return err("project_id, page_id and page_image_base64 required");

  const supabase  = getSupabase();
  const anthropic = getAnthropic();

  // ── Load all device types for this project ────────────────────
  const { data: devices, error: devErr } = await supabase
    .from("device_types")
    .select("id, legend_id, name, description, discipline")
    .eq("project_id", project_id)
    .order("legend_id");

  if (devErr || !devices?.length)
    return err("No device types found for project — run Pass A or import legend first", 404);

  // ── Detect image type ─────────────────────────────────────────
  function detectMediaType(b64) {
    if (b64.startsWith("/9j/"))  return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    return "image/jpeg";
  }
  const mediaType = detectMediaType(page_image_base64);

  // ── Build device list for prompt ──────────────────────────────
  const deviceLines = devices.map(d =>
    `${d.legend_id} | ${d.name} | ${d.description?.slice(0, 120) ?? "no description"}`
  ).join("\n");

  const prompt = `You are scanning an engineering drawing page to identify which device types are present.

Below is the complete device legend for this project. Each line is:
LEGEND_ID | NAME | VISUAL DESCRIPTION

${deviceLines}

Your task:
- Carefully scan the full drawing image
- Identify which of the above devices appear at least once on this page
- Do NOT include devices from the legend box itself — only devices placed on the drawing
- Do NOT include devices you are uncertain about — only include confirmed sightings
- Estimate the count for each device you find (approximate is fine)

Return ONLY valid JSON — no markdown, no extra text:
{
  "devices_present": [
    {
      "legend_id": "DEV_001",
      "name": "Combination Telephone/Data Outlet",
      "estimated_count": 12,
      "confidence": "high|medium|low",
      "notes": "clustered along corridor walls"
    }
  ],
  "devices_absent": ["DEV_002", "DEV_003"],
  "scan_notes": "brief notes on drawing density or anything unusual",
  "warnings": []
}`;

  // ── Call Claude ───────────────────────────────────────────────
  let msgText;
  try {
    const msg = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 2048,
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

  // ── Parse ─────────────────────────────────────────────────────
  let result;
  try {
    const raw = msgText.replace(/```json|```/g, "").trim();
    result = JSON.parse(raw);
  } catch (e) {
    return err(`JSON parse error: ${e.message} — raw: ${msgText.slice(0, 300)}`, 502);
  }

  // ── Enrich with DB ids ────────────────────────────────────────
  const deviceMap = Object.fromEntries(devices.map(d => [d.legend_id, d]));
  const enriched  = (result.devices_present ?? []).map(d => ({
    ...d,
    id:          deviceMap[d.legend_id]?.id          ?? null,
    discipline:  deviceMap[d.legend_id]?.discipline  ?? null,
    description: deviceMap[d.legend_id]?.description ?? null
  }));

  // ── Update page record with scan results ──────────────────────
  await supabase
    .from("pages")
    .update({ pass_b2_complete: true })
    .eq("id", page_id);

  return ok({
    pass:            "device_prescan",
    page_id,
    project_id,
    devices_present: enriched,
    devices_absent:  result.devices_absent  ?? [],
    scan_notes:      result.scan_notes      ?? "",
    warnings:        result.warnings        ?? []
  });
}

export const config = { path: "/api/pass-b2-scan" };
