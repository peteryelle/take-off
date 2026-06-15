// netlify/functions/pass-b2-scan.js
// Pass B2 — Strip-based Device Pre-Scan (drawing-bounded, high accuracy)
// Scans the drawing area only, 6 strips in parallel, all device types per strip.
// Returns a confident device list that drives Pass C auto-execution.
// POST { project_id, page_id, page_image_base64 }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
import { makeCroppedStrips } from "./utils/strips.js";

const N_STRIPS = 6;

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
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  const anthropic = getAnthropic();

  // ── Load page (for drawing bounds) + all device types ────────
  const [{ data: page, error: pageErr }, { data: devices, error: devErr }] = await Promise.all([
    supabase.from("pages").select("*").eq("id", page_id).single(),
    supabase.from("device_types")
      .select("id, legend_id, name, description, discipline, category")
      .eq("project_id", project_id)
      .order("legend_id")
  ]);

  if (pageErr || !page)         return err("Page not found", 404);
  if (devErr  || !devices?.length) return err("No devices found for project", 404);

  // ── Resolve drawing bounds ────────────────────────────────────
  const drawingBounds = (page.drawing_x0 != null) ? {
    x0: page.drawing_x0,
    y0: page.drawing_y0 ?? 0,
    x1: page.drawing_x1,
    y1: page.drawing_y1 ?? 1
  } : null;

  // ── Slice drawing area into strips ────────────────────────────
  let strips;
  try {
    strips = drawingBounds
      ? await makeCroppedStrips(page_image_base64, drawingBounds, N_STRIPS, 0.10)
      : await makeCroppedStrips(page_image_base64,
          { x0: 0, y0: 0, x1: 1, y1: 1 }, N_STRIPS, 0.10);
  } catch (e) {
    return err(`Strip generation failed: ${e.message}`, 500);
  }

  // ── Build device reference list for prompt ────────────────────
  const deviceLines = devices.map(d =>
    `${d.legend_id} | ${d.name} | ${(d.description ?? '').slice(0, 150)}`
  ).join("\n");

  // ── Auto-detect image type ────────────────────────────────────
  function detectMediaType(b64) {
    if (b64.startsWith("/9j/"))  return "image/jpeg";
    if (b64.startsWith("iVBOR")) return "image/png";
    return "image/jpeg";
  }

  // ── Scan each strip in parallel ───────────────────────────────
  const stripResults = await Promise.all(
    strips.map(async (strip, i) => {
      const prompt = `You are scanning strip ${i + 1} of ${N_STRIPS} of an engineering drawing floor plan.
This strip covers y=${strip.y_norm_start.toFixed(3)}–${strip.y_norm_end.toFixed(3)} of the drawing area.

Below is the complete device legend. Each line: LEGEND_ID | NAME | VISUAL DESCRIPTION
${deviceLines}

Your task:
- Carefully examine this strip for any device symbols
- Only report devices you can clearly identify — do NOT guess
- Do NOT include devices from title blocks, notes columns, or keynote callouts
- Estimate count per device type visible in this strip only
- Use confidence: high = clearly matches description, medium = likely match, low = possible but uncertain

Return ONLY valid JSON — no markdown, no extra text:
{
  "devices_found": [
    {
      "legend_id": "DEV_001",
      "name": "device name",
      "estimated_count": 3,
      "confidence": "high|medium|low",
      "notes": "brief observation"
    }
  ],
  "strip_notes": "brief description of what this strip contains"
}
If no devices found: { "devices_found": [], "strip_notes": "description of strip content" }`;

      let rawText = "";
      try {
        const msg = await anthropic.messages.create({
          model:      "claude-sonnet-4-5",
          max_tokens: 8096,
          system:     SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: detectMediaType(strip.base64), data: strip.base64 } },
              { type: "text", text: prompt }
            ]
          }]
        });
        rawText = msg.content[0].text;
        const clean  = rawText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        return {
          strip_index:  i,
          devices_found: parsed.devices_found ?? [],
          strip_notes:  parsed.strip_notes ?? "",
          error:        null
        };
      } catch (e) {
        return {
          strip_index:   i,
          devices_found: [],
          strip_notes:   "",
          error:         `Strip ${i} error: ${e.message} | raw: ${rawText.slice(0, 200)}`
        };
      }
    })
  );

  // ── Merge results across strips ───────────────────────────────
  const deviceMap   = {};  // legend_id → merged result
  const stripNotes  = [];
  const errors      = [];

  for (const result of stripResults) {
    if (result.error) errors.push(result.error);
    if (result.strip_notes) stripNotes.push(`Strip ${result.strip_index + 1}: ${result.strip_notes}`);

    for (const d of result.devices_found) {
      if (!deviceMap[d.legend_id]) {
        deviceMap[d.legend_id] = {
          legend_id:       d.legend_id,
          name:            d.name,
          estimated_count: 0,
          confidence:      d.confidence,
          strips_found_in: [],
          notes:           []
        };
      }
      const existing = deviceMap[d.legend_id];
      existing.estimated_count += (d.estimated_count ?? 1);
      existing.strips_found_in.push(result.strip_index + 1);
      if (d.notes) existing.notes.push(d.notes);

      // Upgrade confidence: high > medium > low
      const rank = { high: 3, medium: 2, low: 1 };
      if ((rank[d.confidence] ?? 0) > (rank[existing.confidence] ?? 0)) {
        existing.confidence = d.confidence;
      }
    }
  }

  // ── Enrich with DB ids ────────────────────────────────────────
  const dbMap = Object.fromEntries(devices.map(d => [d.legend_id, d]));
  const confirmed = Object.values(deviceMap)
    .filter(d => d.confidence !== "low")   // exclude low confidence
    .map(d => ({
      ...d,
      id:          dbMap[d.legend_id]?.id          ?? null,
      discipline:  dbMap[d.legend_id]?.discipline  ?? null,
      description: dbMap[d.legend_id]?.description ?? null,
      notes:       d.notes.join("; ")
    }))
    .sort((a, b) => b.estimated_count - a.estimated_count);

  const lowConfidence = Object.values(deviceMap)
    .filter(d => d.confidence === "low")
    .map(d => ({ ...d, id: dbMap[d.legend_id]?.id ?? null }));

  // ── Update page record ────────────────────────────────────────
  await supabase.from("pages")
    .update({ pass_b2_complete: true })
    .eq("id", page_id);

  return ok({
    pass:            "device_prescan",
    page_id,
    project_id,
    strips_scanned:  N_STRIPS,
    drawing_bounded: drawingBounds != null,
    devices_confirmed: confirmed,         // high/medium confidence — drive Pass C
    devices_low_confidence: lowConfidence, // flag for human review
    strip_notes:     stripNotes,
    errors,
    warnings: errors.length > 0
      ? [`${errors.length} strip(s) had errors`]
      : []
  });
}

export const config = { path: "/api/pass-b2-scan" };
