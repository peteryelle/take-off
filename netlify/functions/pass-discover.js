// netlify/functions/pass-discover.js
// Symbol Discovery — drawing-first device library builder
//
// Actions:
//   scan     — Pass 1 (floor plan scan) + Pass 2 (legend reconciliation)
//   approve  — confirm a cluster → generate llm_description → write to device_types
//   reject   — discard a cluster
//   skip     — mark cluster as skipped (found but won't be detected)
//   complete — finalize session, return detection scope
//
// POST /api/pass-discover
// Body: { action, project_id, ...action-specific fields }
// ─────────────────────────────────────────────────────────────────

import Anthropic       from "@anthropic-ai/sdk";
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
      case "scan":     return await actionScan(body);
      case "approve":  return await actionApprove(body);
      case "reject":   return await actionReject(body);
      case "skip":     return await actionSkip(body);
      case "complete": return await actionComplete(body);
      default: return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error("[pass-discover]", e);
    return respond(500, { error: e.message });
  }
}

// ── Response helper ───────────────────────────────────────────────
function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ── Claude: vision call ───────────────────────────────────────────
async function claudeVision(imageB64Array, prompt, maxTokens = 2000) {
  const content = imageB64Array.map(b64 => ({
    type:   "image",
    source: { type: "base64", media_type: "image/jpeg", data: b64 }
  }));
  content.push({ type: "text", text: prompt });

  const resp = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: maxTokens,
    messages:   [{ role: "user", content }]
  });
  return resp.content[0].text;
}

// ── Claude: text-only call (no images) ───────────────────────────
async function claudeText(prompt, maxTokens = 1000) {
  const resp = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: maxTokens,
    messages:   [{ role: "user", content: prompt }]
  });
  return resp.content[0].text;
}

// ── JSON parser (strips markdown fences) ─────────────────────────
function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Noise filter ──────────────────────────────────────────────────
// Returns { noise: bool, reason: string }
// Applied before the human sees anything.
function classifyNoise(cluster) {
  const desc = (cluster.visual_description || "").toLowerCase();
  const loc  = (cluster.location_pattern   || "").toLowerCase();
  const text = cluster.nearby_text || [];

  if (/dashed.{0,10}line|line.{0,10}pattern|routing.{0,10}path|conduit/.test(desc))
    return { noise: true, reason: "Conduit or routing line" };

  if (/number.{0,20}inside|numbered.{0,10}circle|detail.{0,10}ref|callout|keynote/.test(desc))
    return { noise: true, reason: "Keynote callout or detail reference bubble" };

  if (/\barrow\b|directional|flow.{0,10}direction/.test(desc) && text.length === 0)
    return { noise: true, reason: "Directional arrow or flow indicator" };

  // Very high frequency + no anchors = almost certainly background element
  if ((cluster.approximate_count || 0) > 40 && text.length === 0)
    return { noise: true, reason: "High frequency with no text anchors — likely background element" };

  return { noise: false, reason: null };
}

// ── Text anchor normalization ─────────────────────────────────────
// Input:  ["DD", "DV"]  (already base-pattern from Pass 1)
// Output: { primary: ["DD1","DD2","DD3"], associated: ["DD4","DD5","DD6",...] }
function normalizeAnchors(nearbyText) {
  if (!nearbyText || nearbyText.length === 0) return { primary: [], associated: [] };

  const primary    = [];
  const associated = [];

  nearbyText.forEach(base => {
    const b = base.trim();
    if (!b) return;

    // Check if it looks like a base pattern (no trailing digit) — expand it
    if (/[A-Z]$/.test(b)) {
      primary.push(`${b}1`, `${b}2`, `${b}3`);
      associated.push(`${b}4`, `${b}5`, `${b}6`);
    } else {
      // Already a specific label (WAP, AP, J-BOX) — use as-is
      primary.push(b);
    }
  });

  return {
    primary:    [...new Set(primary)],
    associated: [...new Set(associated)]
  };
}

// ═════════════════════════════════════════════════════════════════
// ACTION: SCAN
// Runs Pass 1 (floor plan discovery) + Pass 2 (legend reconciliation)
// Stores clusters in Supabase, returns review-ready list.
// ═════════════════════════════════════════════════════════════════
async function actionScan(body) {
  const {
    project_id,
    sample_images,          // base64 JPEG array — floor plan pages
    legend_images,          // base64 JPEG array — legend pages
    sample_page_numbers,    // PDF page numbers (for audit)
    legend_page_numbers
  } = body;

  if (!sample_images?.length) return respond(400, { error: "sample_images required" });
  if (!legend_images?.length)  return respond(400, { error: "legend_images required" });

  // ── Create session record ──
  const { data: session, error: sessErr } = await supabase
    .from("discovery_sessions")
    .insert({
      project_id,
      status:              "scanning",
      sample_page_numbers: sample_page_numbers ?? [],
      legend_page_numbers: legend_page_numbers ?? [],
      scan_started_at:     new Date()
    })
    .select("id")
    .single();

  if (sessErr) return respond(500, { error: "Session create failed: " + sessErr.message });
  const session_id = session.id;

  // ── Pass 1: Scan each floor plan page ──
  const rawClusters = [];

  for (let i = 0; i < sample_images.length; i++) {
    let parsed;
    try {
      const raw = await claudeVision([sample_images[i]], PASS1_PROMPT);
      parsed = parseJSON(raw);
    } catch (e) {
      console.warn(`Pass 1 page ${i} parse failed:`, e.message);
      continue;
    }
    (parsed.symbols_found || []).forEach(s => rawClusters.push({ ...s, source_page: i }));
  }

  // Merge duplicate cluster_ids across pages (accumulate count)
  const mergedMap = {};
  rawClusters.forEach(c => {
    if (!mergedMap[c.cluster_id]) {
      mergedMap[c.cluster_id] = { ...c };
    } else {
      mergedMap[c.cluster_id].approximate_count =
        (mergedMap[c.cluster_id].approximate_count || 0) + (c.approximate_count || 0);
    }
  });
  const clusters = Object.values(mergedMap);

  // ── Pass 2: Legend reconciliation ──
  await supabase.from("discovery_sessions")
    .update({ status: "reconciling", updated_at: new Date() })
    .eq("id", session_id);

  const clusterSummary = clusters.map(c =>
    `Cluster ${c.cluster_id}: ${c.visual_description} | nearby text base patterns: [${(c.nearby_text || []).join(", ")}]`
  ).join("\n");

  let matchMap = {};
  try {
    const pass2Raw = await claudeVision(legend_images, PASS2_PROMPT(clusterSummary));
    const parsed2  = parseJSON(pass2Raw);
    (parsed2.matches || []).forEach(m => matchMap[m.cluster_id] = m);
  } catch (e) {
    console.warn("Pass 2 reconciliation failed:", e.message);
  }

  // ── Build cluster rows ──
  let clusterIndex = 0;
  const rows = clusters.map(c => {
    const { noise, reason } = classifyNoise(c);
    const match = matchMap[c.cluster_id] || {};
    if (!noise) clusterIndex++;

    return {
      session_id,
      project_id,
      cluster_id:         c.cluster_id,
      cluster_index:      noise ? null : clusterIndex,
      visual_description: c.visual_description,
      nearby_text:        c.nearby_text || [],
      approximate_count:  c.approximate_count || 0,
      location_pattern:   c.location_pattern || null,
      source_strip:       c.source_page ?? null,
      is_noise:           noise,
      noise_reason:       reason || null,
      legend_name:        match.legend_name        || null,
      legend_description: match.legend_description || null,
      match_confidence:   match.match_confidence   || "low",
      match_reason:       match.confidence_reason  || null,
      review_status:      "pending",
      detect_on_run:      false
    };
  });

  const { error: insertErr } = await supabase.from("discovery_clusters").insert(rows);
  if (insertErr) return respond(500, { error: "Cluster insert failed: " + insertErr.message });

  // ── Update session summary ──
  const nonNoise   = rows.filter(r => !r.is_noise);
  const highCount  = nonNoise.filter(r => r.match_confidence === "high").length;
  const medCount   = nonNoise.filter(r => r.match_confidence === "medium").length;
  const lowCount   = nonNoise.filter(r => r.match_confidence === "low").length;
  const noiseCount = rows.filter(r => r.is_noise).length;

  await supabase.from("discovery_sessions").update({
    status:            "review",
    clusters_found:    nonNoise.length,
    clusters_high:     highCount,
    clusters_medium:   medCount,
    clusters_low:      lowCount,
    clusters_noise:    noiseCount,
    scan_completed_at: new Date(),
    review_started_at: new Date(),
    updated_at:        new Date()
  }).eq("id", session_id);

  return respond(200, {
    session_id,
    clusters_found: nonNoise.length,
    clusters_noise: noiseCount,
    summary: { high: highCount, medium: medCount, low: lowCount, noise: noiseCount },
    clusters: nonNoise.map(r => ({
      cluster_id:         r.cluster_id,
      cluster_index:      r.cluster_index,
      visual_description: r.visual_description,
      nearby_text:        r.nearby_text,
      approximate_count:  r.approximate_count,
      location_pattern:   r.location_pattern,
      legend_name:        r.legend_name,
      legend_description: r.legend_description,
      match_confidence:   r.match_confidence,
      match_reason:       r.match_reason
    }))
  });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: APPROVE
// Confirms a cluster, generates llm_description, writes to device_types.
// Called when estimator clicks Confirm or picks a different legend entry.
// ═════════════════════════════════════════════════════════════════
async function actionApprove(body) {
  const { project_id, session_id, cluster_db_id, final_name } = body;
  if (!session_id)    return respond(400, { error: "session_id required" });
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });

  // Load cluster
  const { data: cluster, error: clErr } = await supabase
    .from("discovery_clusters")
    .select("*")
    .eq("id", cluster_db_id)
    .single();

  if (clErr || !cluster) return respond(404, { error: "Cluster not found" });

  const confirmedName = final_name || cluster.legend_name || "Unknown Device";

  // Generate structured llm_description from drawing observation
  let llm_description = "";
  try {
    llm_description = await claudeText(
      LLM_DESC_PROMPT(cluster.visual_description, confirmedName, cluster.legend_description)
    );
    llm_description = llm_description.trim();
  } catch (e) {
    // Fallback: use visual description directly
    llm_description = `SHAPE: ${cluster.visual_description}\nTEXT NEARBY: ${(cluster.nearby_text || []).join(", ")}`;
  }

  // Normalize text anchors
  const text_anchors = normalizeAnchors(cluster.nearby_text);

  // Upsert to device_types
  const legend_id = `DISC_${session_id}_${cluster.cluster_id}`;
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

  // Update cluster record
  await supabase.from("discovery_clusters").update({
    review_status:  "approved",
    final_name:     confirmedName,
    detect_on_run:  true,
    device_type_id: dt.id,
    reviewed_at:    new Date(),
    updated_at:     new Date()
  }).eq("id", cluster_db_id);

  // Write audit record
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

  return respond(200, {
    device_type_id: dt.id,
    legend_id,
    confirmed_name: confirmedName,
    llm_description,
    text_anchors
  });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: REJECT
// Discards a cluster — not a real device or wrong context.
// ═════════════════════════════════════════════════════════════════
async function actionReject(body) {
  const { cluster_db_id } = body;
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });

  await supabase.from("discovery_clusters").update({
    review_status: "rejected",
    detect_on_run: false,
    reviewed_at:   new Date(),
    updated_at:    new Date()
  }).eq("id", cluster_db_id);

  return respond(200, { status: "rejected" });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: SKIP
// Cluster is real but estimator doesn't need it detected on this job.
// ═════════════════════════════════════════════════════════════════
async function actionSkip(body) {
  const { cluster_db_id } = body;
  if (!cluster_db_id) return respond(400, { error: "cluster_db_id required" });

  await supabase.from("discovery_clusters").update({
    review_status: "skipped",
    detect_on_run: false,
    reviewed_at:   new Date(),
    updated_at:    new Date()
  }).eq("id", cluster_db_id);

  return respond(200, { status: "skipped" });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: COMPLETE
// Finalizes session, returns the detection scope for this project.
// ═════════════════════════════════════════════════════════════════
async function actionComplete(body) {
  const { session_id } = body;
  if (!session_id) return respond(400, { error: "session_id required" });

  await supabase.from("discovery_sessions").update({
    status:              "complete",
    review_completed_at: new Date(),
    updated_at:          new Date()
  }).eq("id", session_id);

  const { data: devices } = await supabase
    .from("discovery_clusters")
    .select("id, cluster_id, final_name, legend_name, approximate_count, device_type_id, match_confidence")
    .eq("session_id", session_id)
    .eq("detect_on_run", true)
    .order("cluster_index");

  return respond(200, {
    status:           "complete",
    devices_in_scope: (devices || []).length,
    devices:          devices || []
  });
}

// ═════════════════════════════════════════════════════════════════
// PROMPTS
// ═════════════════════════════════════════════════════════════════

const PASS1_PROMPT = `This is a telecommunications floor plan drawing for a hospital building.

Find every distinct device symbol type that repeats on this drawing.

For each symbol type:
1. Describe EXACTLY what it looks like as drawn — shape, fill, size, any internal marks
2. Note the BASE text label pattern seen nearby — strip numeric suffixes:
   if you see DD1, DD2, DD3 → write "DD"
   if you see WAP → write "WAP"
   if you see J-BOX → write "J-BOX"
3. Count approximately how many times it appears
4. Note where it tends to appear

EXCLUDE — these are not devices:
- Dashed lines, conduit routing paths, cable runs
- Circles or bubbles containing numbers only (keynote callouts, detail references)
- Directional arrows or triangular routing indicators  
- Room name labels, dimension strings, grid coordinate letters/numbers
- Title block elements, north arrows, scale bars

Only include symbols that appear at least 3 times.

Return ONLY valid JSON — no markdown fences, no preamble:
{
  "symbols_found": [
    {
      "cluster_id": "A",
      "visual_description": "precise description of shape, fill, size, marks exactly as seen on drawing",
      "nearby_text": ["DD", "DV"],
      "approximate_count": 65,
      "location_pattern": "appears at wall locations throughout corridors and patient rooms"
    }
  ]
}`;

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
SIZE: [approximate size as seen on drawing, e.g. "approximately 3mm diameter"]
FILL: [solid/outline/hatched/white fill/etc]
BORDER: [line weight and style]
INTERNAL MARKS: [any internal lines, text, crosshairs, or none]
TEXT NEARBY: [text labels consistently appearing adjacent to this symbol]
LOCATION: [where it typically appears — walls, ceiling grid, corridors, etc]
LOOK-ALIKES: [other symbols it might be confused with, and how to tell them apart]

Return only the structured description — no preamble, no explanation.`;

export const config = { path: "/api/pass-discover" };
