// netlify/functions/pass-discover.js
// Symbol Discovery — drawing-first device library builder
//
// Actions:
//   scan_strip   — scan one horizontal strip of a floor plan page
//   reconcile    — Pass 2: match clusters to legend
//   store_session — persist clusters + crops to DB, return session
//   approve      — confirm cluster → llm_description → device_types
//   reject       — discard cluster
//   skip         — found but not detecting on this job
//   complete     — finalize session, return detection scope
//   load_session — return all non-noise clusters for a session
//
// POST /api/pass-discover
// Body: { action, project_id, ...action-specific fields }
// ─────────────────────────────────────────────────────────────────

import Anthropic        from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Entry point ───────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });

  let body;
  try { body = await req.json(); }
  catch { return respond(400, { error: "Invalid JSON" }); }

  const { action, project_id } = body;
  if (!action)     return respond(400, { error: "action required" });
  if (!project_id) return respond(400, { error: "project_id required" });

  try {
    switch (action) {
      case "scan_strip":    return await actionScanStrip(body);
      case "reconcile":     return await actionReconcile(body);
      case "store_session": return await actionStoreSession(body);
      case "approve":       return await actionApprove(body);
      case "reject":        return await actionReject(body);
      case "skip":          return await actionSkip(body);
      case "complete":      return await actionComplete(body);
      case "load_session":  return await actionLoadSession(body);
      default: return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("[pass-discover]", e);
    return respond(500, { error: e.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function claudeVision(imageB64Array, prompt, maxTokens = 2000) {
  const content = imageB64Array.map(b64 => ({
    type:   "image",
    source: { type: "base64", media_type: "image/jpeg", data: b64 }
  }));
  content.push({ type: "text", text: prompt });
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: maxTokens,
    messages: [{ role: "user", content }]
  });
  return resp.content[0].text;
}

async function claudeText(prompt, maxTokens = 1000) {
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  });
  return resp.content[0].text;
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Noise filter ──────────────────────────────────────────────────
function classifyNoise(cluster) {
  const desc = (cluster.visual_description || "").toLowerCase();
  const text = cluster.nearby_text || [];

  if (/dashed.{0,10}line|line.{0,10}pattern|routing.{0,10}path|conduit/.test(desc))
    return { noise: true, reason: "Conduit or routing line" };

  if (/number.{0,20}inside|numbered.{0,10}circle|detail.{0,10}ref|callout|keynote/.test(desc))
    return { noise: true, reason: "Keynote callout or detail reference bubble" };

  if (/\barrow\b|directional|flow.{0,10}direction/.test(desc) && text.length === 0)
    return { noise: true, reason: "Directional arrow or flow indicator" };

  if ((cluster.approximate_count || 0) > 60 && text.length === 0)
    return { noise: true, reason: "High frequency with no text anchors — likely background element" };

  return { noise: false, reason: null };
}

// ── Text anchor normalization ─────────────────────────────────────
function normalizeAnchors(nearbyText) {
  if (!nearbyText || nearbyText.length === 0) return { primary: [], associated: [] };
  const primary = [], associated = [];
  nearbyText.forEach(base => {
    const b = base.trim();
    if (!b) return;
    if (/[A-Z]$/.test(b)) {
      primary.push(`${b}1`, `${b}2`, `${b}3`);
      associated.push(`${b}4`, `${b}5`, `${b}6`);
    } else {
      primary.push(b);
    }
  });
  return { primary: [...new Set(primary)], associated: [...new Set(associated)] };
}

// ═════════════════════════════════════════════════════════════════
// ACTION: SCAN_STRIP
// Scans one horizontal strip of a floor plan page.
// Returns symbols found + their positions within the strip.
// Browser calls this once per strip, accumulates results.
// ═════════════════════════════════════════════════════════════════
async function actionScanStrip(body) {
  const { strip_image, strip_index, y_start_frac, y_end_frac } = body;
  if (!strip_image) return respond(400, { error: "strip_image required" });

  const yRange = (y_end_frac - y_start_frac);
  const prompt = `This is a horizontal band from a telecommunications floor plan drawing.

Find every distinct repeating device symbol visible in this image.

For EACH symbol type found:
1. Describe EXACTLY what you see — shape, fill, size, line weight, internal marks
2. Note the device label text DIRECTLY adjacent to the symbol (within 1-2 symbol widths).
   Valid device labels look like: DD1, DD2, DV1, N2, WAP, AP, J-BOX, CAM, PTZ
   Strip trailing numbers to get base pattern: DD1/DD2/DD3 → "DD", N1/N2 → "N"
3. Count how many instances appear in this image
4. Estimate position of one clear example:
   - x_frac: 0.0 (left edge) to 1.0 (right edge)
   - y_frac_strip: 0.0 (top) to 1.0 (bottom)

CRITICAL — DRAWING COORDINATE GRID HEADERS (these are NOT device symbols):
Engineering drawings have a coordinate reference grid along their borders. You will see:
- A horizontal row of circles running across the TOP or BOTTOM edge of the image.
  Each circle contains a letter (E, F, G, H, I, J, K, L, M, N...) or letter-number
  combination (K.9, L.1, i.2, 17.1) with vertical lines extending from each circle.
- A row of numerals (4, 5, 6, 7, 8, 9, 10...) along the left or right edge.
These LOOK like device symbols but are the sheet coordinate reference system.
EXCLUDE them entirely. Do not count them. Do not include their letters as text anchors.

EXCLUDE — also not device symbols:
- Dashed lines, solid lines, conduit runs, cable routing paths
- Circles containing only plain numerals — keynote callouts
- Directional arrows or triangular routing indicators with no device label
- Room name text, general notes, dimension strings, title block elements

EXCLUDE from nearby_text — not device labels:
- Single alphabet letters in evenly spaced rows at drawing edges (grid coordinates)
- Letter-number grid codes: K.9, L.1, i.2, 17.1, 19.1
- Room names, area labels, general annotation text

Only include symbols appearing 2 or more times.

Return ONLY valid JSON — no markdown fences, no preamble:
{
  "symbols": [
    {
      "cluster_id": "A",
      "visual_description": "precise description of shape and appearance",
      "nearby_text": ["DD"],
      "approximate_count": 12,
      "x_frac": 0.35,
      "y_frac_strip": 0.4,
      "location_pattern": "at wall locations near room entrances"
    }
  ]
}`;

  try {
    const raw = await claudeVision([strip_image], prompt);
    const parsed = parseJSON(raw);

    // Translate y_frac_strip → y_frac_full_page
    const symbols = (parsed.symbols || []).map(s => ({
      ...s,
      y_frac_full_page: y_start_frac + ((s.y_frac_strip ?? 0.5) * yRange)
    }));

    return respond(200, { symbols });
  } catch (e) {
    console.warn(`scan_strip ${strip_index} failed:`, e.message);
    return respond(200, { symbols: [] }); // soft fail — don't break the loop
  }
}

// ═════════════════════════════════════════════════════════════════
// ACTION: RECONCILE
// Pass 2: matches discovered clusters against the legend.
// Called once after all strips are processed.
// ═════════════════════════════════════════════════════════════════
async function actionReconcile(body) {
  const { clusters, legend_images } = body;
  if (!clusters?.length)    return respond(400, { error: "clusters required" });
  if (!legend_images?.length) return respond(400, { error: "legend_images required" });

  const clusterSummary = clusters.map(c =>
    `Cluster ${c.cluster_id}: ${c.visual_description} | nearby text: [${(c.nearby_text || []).join(", ")}]`
  ).join("\n");

  try {
    const raw = await claudeVision(legend_images, PASS2_PROMPT(clusterSummary));
    const parsed = parseJSON(raw);
    return respond(200, { matches: parsed.matches || [] });
  } catch (e) {
    return respond(500, { error: e.message });
  }
}

// ═════════════════════════════════════════════════════════════════
// ACTION: STORE_SESSION
// Persists clusters + crops to Supabase.
// Called once after reconcile + crop extraction.
// Returns session_id + cluster list with DB ids for the review UI.
// ═════════════════════════════════════════════════════════════════
async function actionStoreSession(body) {
  const {
    project_id, clusters, legend_matches, crops,
    legend_crop_b64, sample_page_numbers, legend_page_numbers
  } = body;

  if (!clusters?.length) return respond(400, { error: "clusters required" });

  // Create session
  const { data: session, error: sessErr } = await supabase
    .from("discovery_sessions")
    .insert({
      project_id,
      status:              "review",
      sample_page_numbers: sample_page_numbers ?? [],
      legend_page_numbers: legend_page_numbers ?? [],
      scan_started_at:     new Date(),
      scan_completed_at:   new Date(),
      review_started_at:   new Date()
    })
    .select("id")
    .single();

  if (sessErr) return respond(500, { error: "Session create failed: " + sessErr.message });
  const session_id = session.id;

  // Build cluster rows
  const matchMap = {};
  (legend_matches || []).forEach(m => matchMap[m.cluster_id] = m);

  let clusterIndex = 0;
  const rows = clusters.map(c => {
    const { noise, reason } = classifyNoise(c);
    const match = matchMap[c.cluster_id] || {};
    if (!noise) clusterIndex++;

    return {
      session_id,
      project_id,
      cluster_id:          c.cluster_id,
      cluster_index:       noise ? null : clusterIndex,
      visual_description:  c.visual_description,
      nearby_text:         c.nearby_text || [],
      approximate_count:   c.approximate_count || 0,
      location_pattern:    c.location_pattern || null,
      source_strip:        c.source_strip ?? null,
      is_noise:            noise,
      noise_reason:        reason || null,
      legend_name:         match.legend_name        || null,
      legend_description:  match.legend_description || null,
      match_confidence:    match.match_confidence   || "low",
      match_reason:        match.confidence_reason  || null,
      drawing_crop_base64: crops?.[c.cluster_id]   || null,  // tight crop around symbol
      legend_crop_base64:  legend_crop_b64          || null,  // full legend page
      review_status:       "pending",
      detect_on_run:       false
    };
  });

  const { error: insertErr } = await supabase.from("discovery_clusters").insert(rows);
  if (insertErr) return respond(500, { error: "Cluster insert failed: " + insertErr.message });

  // Update session summary counts
  const nonNoise = rows.filter(r => !r.is_noise);
  await supabase.from("discovery_sessions").update({
    clusters_found:  nonNoise.length,
    clusters_high:   nonNoise.filter(r => r.match_confidence === "high").length,
    clusters_medium: nonNoise.filter(r => r.match_confidence === "medium").length,
    clusters_low:    nonNoise.filter(r => r.match_confidence === "low").length,
    clusters_noise:  rows.filter(r => r.is_noise).length,
    updated_at:      new Date()
  }).eq("id", session_id);

  // Return clusters with DB ids for the review UI
  const { data: saved } = await supabase
    .from("discovery_clusters")
    .select("id, cluster_id, cluster_index, visual_description, nearby_text, approximate_count, location_pattern, legend_name, legend_description, match_confidence, match_reason, drawing_crop_base64, legend_crop_base64")
    .eq("session_id", session_id)
    .eq("is_noise", false)
    .order("cluster_index");

  return respond(200, {
    session_id,
    clusters:       saved || [],
    clusters_found: nonNoise.length,
    clusters_noise: rows.filter(r => r.is_noise).length,
    summary: {
      high:   nonNoise.filter(r => r.match_confidence === "high").length,
      medium: nonNoise.filter(r => r.match_confidence === "medium").length,
      low:    nonNoise.filter(r => r.match_confidence === "low").length
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: APPROVE
// ═════════════════════════════════════════════════════════════════
async function actionApprove(body) {
  const { project_id, session_id, cluster_db_id, final_name } = body;
  if (!session_id)    return respond(400, { error: "session_id required" });
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });

  const { data: cluster, error: clErr } = await supabase
    .from("discovery_clusters")
    .select("*")
    .eq("id", cluster_db_id)
    .single();

  if (clErr || !cluster) return respond(404, { error: "Cluster not found" });

  const confirmedName = final_name || cluster.legend_name || "Unknown Device";

  let llm_description = "";
  try {
    llm_description = await claudeText(
      LLM_DESC_PROMPT(cluster.visual_description, confirmedName, cluster.legend_description)
    );
    llm_description = llm_description.trim();
  } catch (e) {
    llm_description = `SHAPE: ${cluster.visual_description}\nTEXT NEARBY: ${(cluster.nearby_text || []).join(", ")}`;
  }

  const text_anchors = normalizeAnchors(cluster.nearby_text);
  const legend_id    = `DISC_${session_id}_${cluster.cluster_id}`;

  const { data: dt, error: dtErr } = await supabase
    .from("device_types")
    .upsert({
      project_id,
      legend_id,
      name:                 confirmedName,
      human_description:    cluster.legend_description || "",
      llm_description,
      text_anchors,
      example_image_base64: cluster.drawing_crop_base64 || null,
      updated_at:           new Date()
    }, { onConflict: "project_id,legend_id" })
    .select("id")
    .single();

  if (dtErr) return respond(500, { error: "device_types upsert failed: " + dtErr.message });

  await supabase.from("discovery_clusters").update({
    review_status:  "approved",
    final_name:     confirmedName,
    detect_on_run:  true,
    device_type_id: dt.id,
    reviewed_at:    new Date(),
    updated_at:     new Date()
  }).eq("id", cluster_db_id);

  await supabase.from("discovery_results").insert({
    session_id,
    project_id,
    cluster_id:         cluster_db_id,
    device_type_id:     dt.id,
    confirmed_name:     confirmedName,
    approval_method:    final_name ? "human_renamed" : "human_approved",
    visual_description: cluster.visual_description,
    nearby_text:        cluster.nearby_text,
    match_confidence:   cluster.match_confidence,
    approximate_count:  cluster.approximate_count
  });

  return respond(200, { device_type_id: dt.id, legend_id, confirmed_name: confirmedName, llm_description, text_anchors });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: REJECT
// ═════════════════════════════════════════════════════════════════
async function actionReject(body) {
  const { cluster_db_id } = body;
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });
  await supabase.from("discovery_clusters").update({
    review_status: "rejected", detect_on_run: false,
    reviewed_at: new Date(), updated_at: new Date()
  }).eq("id", cluster_db_id);
  return respond(200, { status: "rejected" });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: SKIP
// ═════════════════════════════════════════════════════════════════
async function actionSkip(body) {
  const { cluster_db_id } = body;
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });
  await supabase.from("discovery_clusters").update({
    review_status: "skipped", detect_on_run: false,
    reviewed_at: new Date(), updated_at: new Date()
  }).eq("id", cluster_db_id);
  return respond(200, { status: "skipped" });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: COMPLETE
// ═════════════════════════════════════════════════════════════════
async function actionComplete(body) {
  const { session_id } = body;
  if (!session_id) return respond(400, { error: "session_id required" });
  await supabase.from("discovery_sessions").update({
    status: "complete", review_completed_at: new Date(), updated_at: new Date()
  }).eq("id", session_id);
  const { data: devices } = await supabase
    .from("discovery_clusters")
    .select("id, cluster_id, final_name, legend_name, approximate_count, device_type_id, match_confidence")
    .eq("session_id", session_id)
    .eq("detect_on_run", true)
    .order("cluster_index");
  return respond(200, { status: "complete", devices_in_scope: (devices || []).length, devices: devices || [] });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: LOAD_SESSION
// ═════════════════════════════════════════════════════════════════
async function actionLoadSession(body) {
  const { session_id } = body;
  if (!session_id) return respond(400, { error: "session_id required" });
  const { data: clusters, error } = await supabase
    .from("discovery_clusters")
    .select("id, cluster_id, cluster_index, visual_description, nearby_text, approximate_count, location_pattern, legend_name, legend_description, match_confidence, match_reason, review_status, drawing_crop_base64, legend_crop_base64")
    .eq("session_id", session_id)
    .eq("is_noise", false)
    .order("cluster_index");
  if (error) return respond(500, { error: error.message });
  return respond(200, { clusters: clusters || [] });
}

// ═════════════════════════════════════════════════════════════════
// PROMPTS
// ═════════════════════════════════════════════════════════════════

const PASS2_PROMPT = clusterSummary => `I scanned a telecommunications floor plan and found these distinct symbol types:

${clusterSummary}

The image is the legend page for the same drawing set.
Match each cluster to the legend entry that best fits its visual description.

Return ONLY valid JSON — no markdown fences, no preamble:
{
  "matches": [
    {
      "cluster_id": "A",
      "legend_name": "exact device name from legend",
      "legend_description": "description as written in legend",
      "match_confidence": "high|medium|low",
      "confidence_reason": "one sentence explaining the match or why confidence is lower"
    }
  ]
}

If a cluster does not match any legend entry, set legend_name to null and match_confidence to "low".`;

const LLM_DESC_PROMPT = (visualDescription, deviceName, legendDescription) =>
`Write a visual detection description for an AI system that will find this device symbol on engineering drawings.

Device: ${deviceName}
Legend description: ${legendDescription || "not available"}
Observed on drawing: ${visualDescription}

Write in this exact format — be precise and calibrated to how the symbol appears on production drawings at small scale:

SHAPE: [geometric shape]
SIZE: [approximate size as seen on drawing]
FILL: [solid/outline/hatched/white fill/etc]
BORDER: [line weight and style]
INTERNAL MARKS: [any internal lines, text, crosshairs, or none]
TEXT NEARBY: [text labels consistently appearing adjacent to this symbol]
LOCATION: [where it typically appears — walls, ceiling grid, corridors, etc]
LOOK-ALIKES: [other symbols it might be confused with and how to tell them apart]

Return only the structured description — no preamble, no explanation.`;

export const config = { path: "/api/pass-discover" };
