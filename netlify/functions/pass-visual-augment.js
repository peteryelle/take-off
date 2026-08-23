// netlify/functions/pass-visual-augment.js
// Visual augmentation pass — runs AFTER pass-batch text-layer detection
// Finds device instances that text-layer missed (e.g. leader-line groups)
// by visually scanning the page and filtering out positions already found.
//
// POST /api/pass-visual-augment
// Body: {
//   project_id,
//   page_id,
//   device_type_id,
//   page_image_base64,
//   existing_positions: [{x_norm, y_norm}],  // from text-layer
//   demarc_pins: [{demarc_id, x_norm, y_norm, stub_ft}],
//   page_width_pts,
//   page_height_pts
// }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg, assertPageInOrg, assertProjectUnlocked } from "./utils/auth.js";
import { makeStrips, toFullCoords, dedup } from "./utils/strips.js";

const N_STRIPS        = 8;
const INTERNAL_DEDUP  = 0.020;   // dedup visual detections against each other
const MERGE_THRESHOLD = 0.025;   // skip visual detection if text-layer already found nearby
const ROUTE_FACTOR    = 1.35;
const TIA_OUTLET_FT   = 295;
const TIA_WAP_FT      = 270;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const {
    project_id, page_id, device_type_id,
    page_image_base64, existing_positions,
    demarc_pins, page_width_pts, page_height_pts
  } = body;

  if (!project_id || !page_id || !device_type_id || !page_image_base64)
    return err("project_id, page_id, device_type_id, page_image_base64 required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  if (!(await assertPageInOrg(supabase, page_id, orgId))) return err("Page not found in your organization", 404);
  if (!(await assertProjectUnlocked(supabase, project_id)))
    return err("Project is locked (accepted final run) — unlock it from the Report page before re-running.", 423);
  const anthropic = getAnthropic();

  // ── Load page + device type ───────────────────────────────────
  const [{ data: page }, { data: device }] = await Promise.all([
    supabase.from("pages").select("*").eq("id", page_id).single(),
    supabase.from("device_types").select("*").eq("id", device_type_id).single()
  ]);

  if (!page)   return err("Page not found",        404);
  if (!device) return err("Device type not found", 404);

  // Use llm_description (from discover flow) or fall back to description
  const visualDesc = device.llm_description ?? device.description;
  if (!visualDesc) return ok({ pass: "visual_augment", new_instances: 0, skipped: "no visual description" });

  // ── Slice page into strips ────────────────────────────────────
  let strips;
  try {
    strips = await makeStrips(page_image_base64, N_STRIPS);
  } catch (e) {
    return err(`Strip generation failed: ${e.message}`, 500);
  }

  // ── Detect in each strip (parallel) ──────────────────────────
  const PROMPT = (strip) =>
`You are scanning strip ${strip.index + 1} of ${N_STRIPS} from a telecommunications floor plan.

Find every instance of this device symbol:
${visualDesc}

Important rules:
- Do NOT count symbols in the legend, title block, or detail insets
- Do NOT count keynote callout bubbles or section reference markers
- Match the visual description precisely — shape, size, fill
- x_frac and y_frac_in_strip are 0-1 relative to THIS STRIP
- Return ALL instances you can see — do not skip any

Return ONLY raw JSON (no markdown):
{
  "devices_found": [
    { "x_frac": 0.35, "y_frac_in_strip": 0.4, "confidence": "high|medium|low" }
  ]
}
If none found: { "devices_found": [] }`;

  const stripResults = await Promise.all(strips.map(async strip => {
    try {
      const msg = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: strip.base64 } },
            { type: "text",  text: PROMPT(strip) }
          ]
        }]
      });
      const clean  = msg.content[0].text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      return { strip, found: parsed.devices_found ?? [] };
    } catch {
      return { strip, found: [] };
    }
  }));

  // ── Convert to full-image coordinates ─────────────────────────
  const rawDetections = [];
  for (const { strip, found } of stripResults) {
    for (const d of found) {
      const coords = toFullCoords(strip, d.x_frac, d.y_frac_in_strip);
      rawDetections.push({
        x: coords.x,
        y: coords.y,
        confidence: d.confidence ?? "medium",
        source_strip: strip.index
      });
    }
  }

  // ── Internal dedup (visual detections against each other) ─────
  const { kept } = dedup(rawDetections, INTERNAL_DEDUP);

  // ── Merge filter — skip positions text-layer already found ────
  const existing = existing_positions ?? [];
  const newOnly  = kept.filter(det => {
    return !existing.some(ep => {
      const dx = Math.abs(det.x - (ep.x_norm ?? ep.x ?? 0));
      const dy = Math.abs(det.y - (ep.y_norm ?? ep.y ?? 0));
      return Math.sqrt(dx*dx + dy*dy) <= MERGE_THRESHOLD;
    });
  });

  if (!newOnly.length) {
    return ok({
      pass:            "visual_augment",
      device_type_id,
      device_name:     device.name,
      visual_found:    kept.length,
      text_layer_had:  existing.length,
      new_instances:   0,
      instances:       []
    });
  }

  // ── Calculate distances for new instances ─────────────────────
  const pins   = demarc_pins ?? [];
  const ptsPerFt = page.scale_pts_per_ft ?? null;

  function nearestPin(cx, cy) {
    if (!pins.length) return null;
    let best = null, bestDist = Infinity;
    for (const pin of pins) {
      const dx = (cx - pin.x_norm) * (page_width_pts  ?? 1);
      const dy = (cy - pin.y_norm) * (page_height_pts ?? 1);
      const d  = Math.sqrt(dx*dx + dy*dy);
      if (d < bestDist) { bestDist = d; best = pin; }
    }
    return { pin: best, dist_pts: bestDist };
  }

  // ── Build and insert new device_instances ─────────────────────
  const rows = newOnly.map(det => {
    const pinResult = nearestPin(det.x, det.y);
    let demarcId    = pinResult?.pin?.demarc_id ?? null;
    let runLengthFt = null;
    let totalFt     = null;
    let tiaFlag     = false;
    let tiaReason   = null;

    if (pinResult?.pin && ptsPerFt) {
      runLengthFt = parseFloat((pinResult.dist_pts * ROUTE_FACTOR / ptsPerFt).toFixed(1));
      totalFt     = parseFloat((runLengthFt + (pinResult.pin.stub_ft ?? 0)).toFixed(1));
      const limit = /WAP/i.test(device.name) ? TIA_WAP_FT : TIA_OUTLET_FT;
      if (totalFt > limit) {
        tiaFlag   = true;
        tiaReason = `${totalFt}ft exceeds ${limit}ft TIA limit`;
      }
    }

    return {
      page_id,
      device_type_id,
      detection_method: 'visual',
      x_norm:           parseFloat(det.x.toFixed(4)),
      y_norm:           parseFloat(det.y.toFixed(4)),
      x_ft:             null,
      y_ft:             null,
      raw_labels:       [],    // no text labels — found visually only
      data_ports:       [],
      voice_ports:      [],
      node_labels:      [],
      port_count_data:  0,
      port_count_voice: 0,
      demarc_id:        demarcId,
      run_length_ft:    runLengthFt,
      total_ft:         totalFt,
      tia_flag:         tiaFlag,
      tia_reason:       tiaReason,
      confidence:       det.confidence
    };
  });

  const { data: inserted, error: insErr } = await supabase
    .from("device_instances")
    .insert(rows)
    .select("id, x_norm, y_norm, total_ft, tia_flag, demarc_id");

  if (insErr) return err(`Insert failed: ${insErr.message}`, 500);

  return ok({
    pass:            "visual_augment",
    device_type_id,
    device_name:     device.name,
    visual_found:    kept.length,
    text_layer_had:  existing.length,
    new_instances:   (inserted ?? []).length,
    instances:       (inserted ?? []).map(r => ({
      id:         r.id,
      x_norm:     r.x_norm,
      y_norm:     r.y_norm,
      total_ft:   r.total_ft,
      tia_flag:   r.tia_flag,
      demarc_id:  r.demarc_id,
      legend_id:  device.legend_id,
      name:       device.name,
      raw_labels: [],
      detection_method: 'visual'
    }))
  });
}

export const config = { path: "/api/pass-visual-augment" };
