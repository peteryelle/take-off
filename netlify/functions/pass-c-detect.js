// netlify/functions/pass-c-detect.js
// Pass C — Device Detection (strip-based, dedup, annotated output)
// POST { page_id, device_type_id, page_image_base64, demarc_override? }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, getAnthropic, SYSTEM_PROMPT, ok, err, CORS } from "./utils/clients.js";
import { makeStrips, toFullCoords, dedup, annotate, calcPath } from "./utils/strips.js";

const DEDUP_THRESHOLD = 0.02;
const N_STRIPS        = 6;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { page_id, device_type_id, page_image_base64, demarc_override } = body;
  if (!page_id || !device_type_id || !page_image_base64)
    return err("page_id, device_type_id and page_image_base64 required");

  const supabase  = getSupabase();
  const anthropic = getAnthropic();
  const startedAt = new Date();

  // ── Load page + device type from DB ──────────────────────────
  const [{ data: page, error: pageErr }, { data: device, error: devErr }] = await Promise.all([
    supabase.from("pages").select("*").eq("id", page_id).single(),
    supabase.from("device_types").select("*").eq("id", device_type_id).single()
  ]);

  if (pageErr  || !page)   return err("Page not found",        404);
  if (devErr   || !device) return err("Device type not found", 404);

  // ── Resolve demarcation ───────────────────────────────────────
  const demarc = demarc_override ?? {
    x:      page.demarc_x,
    y:      page.demarc_y,
    source: page.demarc_source,
    label:  page.demarc_label
  };

  // ── Slice into strips ─────────────────────────────────────────
  let strips;
  try {
    strips = await makeStrips(page_image_base64, N_STRIPS);
  } catch (e) {
    return err(`Strip generation failed: ${e.message}`, 500);
  }

  const imageW = strips[0].width;
  const imageH = strips[0].full_height;

  // ── Detect in each strip ──────────────────────────────────────
  const stripPrompt = (strip) => `
You are scanning strip ${strip.index + 1} of ${N_STRIPS} (y=${strip.y_norm_start.toFixed(3)}–${strip.y_norm_end.toFixed(3)} of full image).

Find every instance of this device:
Name: ${device.name}
Visual description: ${device.description}

Rules:
- Do NOT count legend entries, keynote callouts, or detail insets
- Match shape, fill, border exactly — not just label text
- x_frac and y_frac_in_strip are 0–1 relative to THIS strip (0,0 = top-left of strip)

Return ONLY this JSON:
{
  "devices_found": [
    { "x_frac": 0.25, "y_frac_in_strip": 0.60, "label": "brief location description", "confidence": "high|medium|low" }
  ],
  "warnings": []
}
If none found return: { "devices_found": [], "warnings": [] }
Return ONLY raw JSON — no markdown fences, no backticks, no extra text.`;

  // Run all strips in parallel
  const stripResults = await Promise.all(
    strips.map(async (strip) => {
      try {
        const msg = await anthropic.messages.create({
          model:      "claude-sonnet-4-5",
          max_tokens: 512,
          system:     SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: strip.base64 } },
              { type: "text", text: stripPrompt(strip) }
            ]
          }]
        });
        const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(raw);
        return { strip, found: parsed.devices_found ?? [], warnings: parsed.warnings ?? [] };
      } catch (e) {
        return { strip, found: [], warnings: [`Strip ${strip.index} error: ${e.message}`] };
      }
    })
  );

  // ── Convert to full-image coordinates ─────────────────────────
  const allWarnings = [];
  const rawDetections = [];

  for (const { strip, found, warnings } of stripResults) {
    allWarnings.push(...warnings);
    for (const d of found) {
      const { x, y } = toFullCoords(strip, d.x_frac, d.y_frac_in_strip);
      rawDetections.push({ x, y, label: d.label, confidence: d.confidence, source_strip: strip.index });
    }
  }

  // ── Dedup ─────────────────────────────────────────────────────
  const { kept, removed } = dedup(rawDetections, DEDUP_THRESHOLD);

  // ── Calculate path lengths ────────────────────────────────────
  const detections = kept.map((d, i) => {
    const { path_length_norm, path_length_ft } = calcPath(
      d, demarc, imageW, imageH,
      page.scale_paper_in, page.scale_real_ft
    );
    return {
      ...d,
      detection_label: `D${String(i + 1).padStart(2, "0")}`,
      path_length_norm,
      path_length_ft
    };
  });

  // ── Annotate master image ─────────────────────────────────────
  let annotatedBase64 = null;
  try {
    annotatedBase64 = await annotate(page_image_base64, detections);
  } catch (e) {
    allWarnings.push(`Annotation failed: ${e.message}`);
  }

  // ── Upload annotated image to Supabase Storage ─────────────────
  let annotatedPath = null;
  if (annotatedBase64) {
    const filename  = `annotated/page_${page.pdf_page_number}_dev_${device_type_id}_${Date.now()}.jpg`;
    const imgBuffer = Buffer.from(annotatedBase64, "base64");
    const { error: uploadErr } = await supabase.storage
      .from("schematics")
      .upload(filename, imgBuffer, { contentType: "image/jpeg", upsert: true });
    if (!uploadErr) {
      annotatedPath = filename;
      await supabase.from("pages").update({ image_annotated_path: annotatedPath }).eq("id", page_id);
    } else {
      allWarnings.push(`Storage upload failed: ${uploadErr.message}`);
    }
  }

  const finishedAt = new Date();
  const elapsedSec = (finishedAt - startedAt) / 1000;

  // ── Write detection run ───────────────────────────────────────
  const pathsWithValues = detections.filter(d => d.path_length_ft != null);
  const longestFt  = pathsWithValues.length ? Math.max(...pathsWithValues.map(d => d.path_length_ft)) : null;
  const shortestFt = pathsWithValues.length ? Math.min(...pathsWithValues.map(d => d.path_length_ft)) : null;

  const { data: run, error: runErr } = await supabase
    .from("detection_runs")
    .insert({
      page_id,
      device_type_id,
      total_count:         detections.length,
      duplicates_removed:  removed.length,
      strip_count:         N_STRIPS,
      dedup_threshold:     DEDUP_THRESHOLD,
      longest_run_ft:      longestFt,
      shortest_run_ft:     shortestFt,
      annotated_image_path: annotatedPath,
      started_at:          startedAt.toISOString(),
      finished_at:         finishedAt.toISOString(),
      elapsed_sec:         elapsedSec,
      notes:               allWarnings.join(" | ") || null
    })
    .select("id")
    .single();

  if (runErr) return err(`Run insert failed: ${runErr.message}`, 500);

  // ── Write individual detections ───────────────────────────────
  if (detections.length > 0) {
    const detRows = detections.map(d => ({
      run_id:            run.id,
      page_id,
      device_type_id,
      detection_label:   d.detection_label,
      location_label:    d.label,
      x:                 d.x,
      y:                 d.y,
      source_strip:      d.source_strip,
      path_length_norm:  d.path_length_norm,
      path_length_ft:    d.path_length_ft,
      confidence:        d.confidence,
      flagged:           d.path_length_ft > 295,
      flag_reason:       d.path_length_ft > 295 ? "Exceeds TIA 295ft permanent link limit" : null
    }));

    const { error: detErr } = await supabase.from("detections").insert(detRows);
    if (detErr) allWarnings.push(`Detection insert error: ${detErr.message}`);
  }

  return ok({
    pass:               "device_detection",
    run_id:             run.id,
    page_id,
    device_type_id,
    device_name:        device.name,
    total_count:        detections.length,
    duplicates_removed: removed.length,
    longest_run_ft:     longestFt,
    shortest_run_ft:    shortestFt,
    elapsed_sec:        elapsedSec,
    annotated_image:    annotatedBase64,   // return to frontend for display
    annotated_path:     annotatedPath,
    tia_violations:     detections.filter(d => d.path_length_ft > 295).length,
    warnings:           allWarnings,
    detections
  });
}

export const config = { path: "/api/pass-c-detect" };
