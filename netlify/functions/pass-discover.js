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
import { discoverCatalog } from "../../public/lib/discover-config.js";

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
      case "analyze_crop":    return await actionAnalyzeCrop(body);
      case "read_legend":     return await actionReadLegend(body);
      case "scan_for_symbol": return await actionScanForSymbol(body);
      case "build_device":    return await actionBuildDevice(body);
      case "scan_strip":      return await actionScanStrip(body);
      case "detect_bounds":   return await actionDetectBounds(body);
      case "reconcile":       return await actionReconcile(body);
      case "store_session":   return await actionStoreSession(body);
      case "approve":         return await actionApprove(body);
      case "reject":          return await actionReject(body);
      case "skip":            return await actionSkip(body);
      case "complete":        return await actionComplete(body);
      case "build_catalog":   return await actionBuildCatalog(body);
      case "load_session":    return await actionLoadSession(body);
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
// "DD"  → 1-2 letter base code  → expands to DD1,DD2,DD3 / DD4-DD6
// "DV1" → numbered anchor       → strips digit, expands same way
// "WAP" → 3+ letter acronym     → used as-is (WAP, CAM, PTZ, J-BOX)
// "N"   → 1-letter base         → expands to N1, N2, N3
function normalizeAnchors(nearbyText) {
  if (!nearbyText || nearbyText.length === 0) return { primary: [], associated: [] };
  const primary = [], associated = [];
  nearbyText.forEach(anchor => {
    const b = anchor.replace(/[^\x20-\x7E]/g, '').trim();
    if (!b) return;
    // Numbered anchor: "DV1", "DD2", "N2" — strip digits, expand base
    if (/^[A-Z]+\d+$/.test(b)) {
      const base = b.replace(/\d+$/, '');
      primary.push(`${base}1`, `${base}2`, `${base}3`);
      associated.push(`${base}4`, `${base}5`, `${base}6`);
    // Short base code (1-2 capital letters only): "DD", "DV", "N" — expand
    } else if (/^[A-Z]{1,2}$/.test(b)) {
      primary.push(`${b}1`, `${b}2`, `${b}3`);
      associated.push(`${b}4`, `${b}5`, `${b}6`);
    // Everything else: "WAP", "CAM", "J-BOX", "FACP" — use as-is
    } else {
      primary.push(b);
    }
  });
  return { primary: [...new Set(primary)], associated: [...new Set(associated)] };
}

// ═════════════════════════════════════════════════════════════════
// ACTION: DETECT_BOUNDS
// One call on a low-res thumbnail of the first sample page.
// Returns y_start_frac and y_end_frac — the vertical extent of
// the actual floor plan drawing area, excluding grid headers
// at the top and title block at the bottom.
// Used to calibrate strip slicing for this drawing set.
// ═════════════════════════════════════════════════════════════════
async function actionDetectBounds(body) {
  const { page_image } = body;
  if (!page_image) return respond(400, { error: "page_image required" });

  const prompt = `This is a full engineering drawing sheet.

The sheet has three vertical zones:
1. TOP: A coordinate grid header row — circles containing letters (A, B, C, E, F, G...)
   or numbers arranged in a horizontal row, with vertical lines extending downward.
2. MIDDLE: The actual floor plan drawing content — walls, rooms, device symbols, dimensions.
3. BOTTOM: A title block — company name, project title, sheet number, engineer stamps,
   revision table. This is a structured table, usually dark-bordered.

Identify exactly where the floor plan content area begins and ends vertically.

Return ONLY valid JSON — no markdown, no preamble:
{
  "y_start_frac": 0.07,
  "y_end_frac": 0.91,
  "top_description": "what you found at the top",
  "bottom_description": "what you found at the bottom"
}

y_start_frac: fraction from top of image where floor plan content begins (0.0 = very top)
y_end_frac:   fraction from top of image where floor plan content ends (1.0 = very bottom)`;

  try {
    const raw    = await claudeVision([page_image], prompt, 400);
    const parsed = parseJSON(raw);
    // Clamp to reasonable range
    const yStart = Math.max(0.02, Math.min(0.20, parsed.y_start_frac ?? 0.07));
    const yEnd   = Math.max(0.70, Math.min(0.98, parsed.y_end_frac   ?? 0.91));
    return respond(200, {
      y_start_frac:      yStart,
      y_end_frac:        yEnd,
      top_description:   parsed.top_description   || "",
      bottom_description:parsed.bottom_description|| ""
    });
  } catch (e) {
    console.warn("detect_bounds failed:", e.message);
    return respond(200, { y_start_frac: 0.07, y_end_frac: 0.91,
      top_description: "detection failed — using defaults",
      bottom_description: "" });
  }
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
// ACTION: BUILD_CATALOG
// Turns the approved clusters into v2 detection_config rows. The browser
// supplies the plan text tokens (for frequency confirmation) and, if present,
// the schedule header tokens. discoverCatalog (public/lib) nominates anchors,
// derives UIN patterns, maps schedule columns, and sets sources/confidence.
// Body: { project_id, session_id, plan_tokens: [str], schedule?: { present,
//         headerTokens, locatorTitle }, page_id? (where to store the schedule) }
// ═════════════════════════════════════════════════════════════════
async function actionBuildCatalog(body) {
  const { project_id, session_id, plan_tokens, schedule, page_id } = body;
  if (!project_id || !session_id) return respond(400, { error: "project_id and session_id required" });

  const { data: clusters, error: clErr } = await supabase
    .from("discovery_clusters")
    .select("id, final_name, legend_name, legend_description, nearby_text, approximate_count, drawing_crop_base64, device_type_id")
    .eq("session_id", session_id)
    .eq("detect_on_run", true)
    .order("cluster_index");

  if (clErr) return respond(500, { error: "cluster load failed: " + clErr.message });
  if (!clusters?.length) return respond(404, { error: "No approved clusters — approve devices before building the catalog" });

  // Raw candidates, preserving order so types[i] maps back to clusters[i].
  const rawCandidates = clusters.map((c) => ({
    name:              c.final_name || c.legend_name || "Unknown Device",
    nearby_text:       c.nearby_text || [],
    legend_name:       c.legend_name || null,
    legend_present:    !!c.legend_name,
    approximate_count: c.approximate_count ?? null,
    has_symbol:        !!c.drawing_crop_base64
  }));

  const { types, schedule: scheduleBlock } = discoverCatalog(rawCandidates, plan_tokens || [], schedule || null);

  // Write detection_config to each cluster's device_type row.
  const results = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const dtId = clusters[i].device_type_id;
    if (!dtId) { results.push({ name: t.name, skipped: "no device_type_id — approve the cluster first" }); continue; }
    const { error } = await supabase.from("device_types")
      .update({ detection_config: t.detection_config, updated_at: new Date() })
      .eq("id", dtId);
    results.push({
      name: t.name, device_type_id: dtId,
      anchor: t.detection_config.anchor, anchor_mode: t.detection_config.anchor_mode,
      uin_pattern: t.detection_config.uin_pattern, sources: t.detection_config.sources,
      anchor_confidence: t.detection_config.anchor_confidence, error: error?.message || null
    });
  }

  // Store the sheet-level schedule block (caller says which page hosts the table).
  let scheduleWrite = null;
  if (scheduleBlock) {
    if (page_id) {
      const { error } = await supabase.from("pages").update({ schedule: scheduleBlock }).eq("id", page_id);
      scheduleWrite = { page_id, stored: !error, error: error?.message || null };
    } else {
      scheduleWrite = { stored: false, warning: "schedule parsed but no page_id supplied to store it" };
    }
  }

  return respond(200, {
    catalog: results, schedule: scheduleBlock, schedule_write: scheduleWrite,
    written: results.filter((r) => r.device_type_id && !r.error).length
  });
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
// ACTION: ANALYZE_CROP
// Takes a crop the estimator drew on the floor plan.
// Pass 1: describe the symbol visually.
// Pass 2: match to legend for the official name.
// Returns both so the estimator can confirm.
// ═════════════════════════════════════════════════════════════════
async function actionAnalyzeCrop(body) {
  const { crop_image, legend_image } = body;
  if (!crop_image) return respond(400, { error: "crop_image required" });

  // Pass 1 — describe the symbol from the crop
  const descPrompt = `This is a cropped region from a telecommunications engineering floor plan.
An estimator selected this area because it contains a device symbol they want to count.

Describe what you see:
1. The exact shape, fill, border, and size of the device symbol
2. Any text labels visible directly next to the symbol (DD2, DV1, WAP, N2, etc.)
3. What type of device this appears to be

Return ONLY valid JSON — no markdown:
{
  "visual_description": "precise description of the symbol shape and appearance",
  "nearby_text": ["DD"],
  "device_guess": "informal name e.g. data outlet, WAP, camera"
}`;

  let visual_description = "", nearby_text = [], device_guess = "";
  try {
    const raw    = await claudeVision([crop_image], descPrompt, 600);
    const parsed = parseJSON(raw);
    visual_description = parsed.visual_description || "";
    nearby_text        = parsed.nearby_text        || [];
    device_guess       = parsed.device_guess       || "";
  } catch (e) { console.warn("Crop description failed:", e.message); }

  // Pass 2 — match to legend (if legend provided)
  let legend_name = null, legend_description = "", match_confidence = "low", match_reason = "";
  if (legend_image && visual_description) {
    const matchPrompt = `The first image is a device symbol selected directly from a floor plan drawing.
The second image is the legend page for the same drawing set.

Find the legend entry that best matches this symbol.

Return ONLY valid JSON — no markdown:
{
  "legend_name": "exact name as written in legend",
  "legend_description": "description from legend",
  "match_confidence": "high|medium|low",
  "match_reason": "one sentence"
}

If no match found, set legend_name to null and match_confidence to "low".`;

    try {
      const raw    = await claudeVision([crop_image, legend_image], matchPrompt, 600);
      const parsed = parseJSON(raw);
      legend_name        = parsed.legend_name        || null;
      legend_description = parsed.legend_description || "";
      match_confidence   = parsed.match_confidence   || "low";
      match_reason       = parsed.match_reason       || "";
    } catch (e) { console.warn("Legend match failed:", e.message); }
  }

  return respond(200, {
    visual_description, nearby_text, device_guess,
    legend_name, legend_description, match_confidence, match_reason
  });
}

// ═════════════════════════════════════════════════════════════════
// ACTION: READ_LEGEND
// Reads the legend page and returns every device entry with its
// approximate position in the legend image (for crop extraction).
// This is the queue — it defines what CAN be detected.
// ═════════════════════════════════════════════════════════════════
async function actionReadLegend(body) {
  const { legend_image, scope } = body;
  if (!legend_image) return respond(400, { error: "legend_image required" });

  const scopeText = scope || "telecom devices";

  const prompt = `This is a legend page from a telecommunications engineering drawing set.

The estimator needs to count: ${scopeText}

Find the 3-6 legend entries that best match what the estimator needs.
Do NOT return fire alarm devices, section markers, detail references, or other unrelated symbols
unless explicitly requested.

For each matching entry provide:
1. name: official device name as written in the legend
2. short_description: one sentence describing the device
3. category: one of — telecom | security | fire_alarm | av | nurse_call | osp | other
4. x_frac: horizontal position of the SYMBOL GRAPHIC (0.0=left, 1.0=right)
5. y_frac: vertical position of the SYMBOL GRAPHIC (0.0=top, 1.0=bottom)
6. text_anchors: code labels shown with the symbol (e.g. DD, DV, WAP, N)
7. legend_description: the full description text as written in the legend

Focus on x_frac / y_frac pointing to the actual drawn symbol, not the text description.
Return at most 6 entries — only the most relevant matches.

Return ONLY valid JSON — no markdown, no preamble:
{
  "devices": [
    {
      "id": "LEG_001",
      "name": "Data Outlet",
      "short_description": "Wall-mounted Cat6A data outlet",
      "category": "telecom",
      "x_frac": 0.08,
      "y_frac": 0.12,
      "text_anchors": ["DD"],
      "legend_description": "OUTLET DATA OR VOIP TELEPHONE..."
    }
  ]
}`;

  try {
    const raw    = await claudeVision([legend_image], prompt, 3000);
    const parsed = parseJSON(raw);
    return respond(200, { devices: (parsed.devices || []).slice(0, 6) });
  } catch (e) {
    return respond(500, { error: e.message });
  }
}

// ═════════════════════════════════════════════════════════════════
// ACTION: SCAN_FOR_SYMBOL
// Targeted strip scan for ONE specific symbol.
// Takes a legend crop as the visual reference and finds every
// instance of that symbol in the strip.
// Far more reliable than autonomous "find all" scanning.
// ═════════════════════════════════════════════════════════════════
async function actionScanForSymbol(body) {
  const { strip_image, symbol_crop, symbol_name, y_start_frac, y_end_frac } = body;
  if (!strip_image)  return respond(400, { error: "strip_image required" });
  if (!symbol_crop)  return respond(400, { error: "symbol_crop required" });

  const yStart = y_start_frac || 0;
  const yRange = (y_end_frac  || 1) - yStart;

  const prompt = `The first image is a reference example of a "${symbol_name}" symbol from the engineering legend.
The second image is a horizontal band from a telecommunications floor plan.

Find every instance of THIS SPECIFIC symbol in the floor plan band.
Match by shape, size, and visual characteristics — not by text label alone.

For each instance found:
- x_frac: horizontal position (0.0=left edge, 1.0=right edge)
- y_frac_strip: vertical position within this band (0.0=top, 1.0=bottom)
- nearby_text: device label text directly adjacent (e.g. DD2, DV1, WAP, N2)
  Strip numeric suffix to base: DD2 → "DD", N2 → "N", WAP → "WAP"
- visual_notes: any variation from the reference (rotated, smaller, partially obscured)

If this symbol does not appear in this band, return an empty instances array.
Do not return instances of other symbol types.

Return ONLY valid JSON — no markdown, no preamble:
{
  "instances": [
    {
      "x_frac": 0.35,
      "y_frac_strip": 0.4,
      "nearby_text": ["DD"],
      "visual_notes": "same as reference, pointing left"
    }
  ]
}`;

  try {
    const raw    = await claudeVision([symbol_crop, strip_image], prompt, 1500);
    const parsed = parseJSON(raw);

    const instances = (parsed.instances || []).map(inst => ({
      ...inst,
      y_frac_full_page: yStart + ((inst.y_frac_strip ?? 0.5) * yRange)
    }));

    return respond(200, { instances });
  } catch (e) {
    console.warn("scan_for_symbol failed:", e.message);
    return respond(200, { instances: [] }); // soft fail
  }
}

// ═════════════════════════════════════════════════════════════════
// ACTION: BUILD_DEVICE
// Takes all scan observations for one device type, generates
// a calibrated llm_description from real drawing appearances,
// and stores to device_types.
// ═════════════════════════════════════════════════════════════════
async function actionBuildDevice(body) {
  const {
    project_id, legend_entry, all_instances,
    drawing_crop_base64, legend_crop_base64
  } = body;

  if (!project_id)   return respond(400, { error: "project_id required" });
  if (!legend_entry) return respond(400, { error: "legend_entry required" });

  // Aggregate text anchors from all observed instances
  const allNearbyText = [...new Set(
    all_instances.flatMap(i => i.nearby_text || [])
  )];

  // Collect visual variation notes
  const visualNotes = all_instances
    .map(i => i.visual_notes).filter(Boolean)
    .slice(0, 8).join("; ");

  const instanceCount = all_instances.length;

  const descPrompt = `Write a visual detection description for an AI system that will find this device symbol on engineering drawings.

Device: ${legend_entry.name}
Legend description: ${legend_entry.legend_description || legend_entry.short_description || "not available"}

Observed on actual floor plan drawings (${instanceCount} instance${instanceCount !== 1 ? "s" : ""} found):
${visualNotes || "Symbol appears consistent with legend reference"}

Text labels consistently found adjacent to this symbol: ${allNearbyText.join(", ") || "none observed"}

Write in this exact format — be precise and calibrated to production drawing scale:

SHAPE: [geometric shape]
SIZE: [approximate size as drawn on floor plan]
FILL: [solid/outline/hatched/etc]
BORDER: [line weight and style]
INTERNAL MARKS: [internal detail or none]
TEXT NEARBY: [text labels consistently adjacent]
LOCATION: [where it typically appears — walls, ceiling, corridors, etc]
LOOK-ALIKES: [similar symbols and how to distinguish]

Return only the structured description — no preamble, no explanation.`;

  let llm_description = "";
  try {
    llm_description = (await claudeText(descPrompt, 800)).trim();
  } catch (e) {
    llm_description = `SHAPE: See legend\nTEXT NEARBY: ${allNearbyText.join(", ") || "none"}`;
  }

  // Normalize text anchors — prefer observed over legend
  const anchorSource = allNearbyText.length
    ? allNearbyText
    : (legend_entry.text_anchors || []);
  const text_anchors = normalizeAnchors(anchorSource);

  // ── v2 contract: derive detection_config from the observed plan instances ──
  // discoverCatalog nominates the primary anchor by frequency (the token that recurs
  // ~once per instance — N2/WAP/180) and the secondary families (DV/DD/N) from the
  // base codes around it. Per-instance nearby_text supplies that frequency signal.
  const planTokensFlat = all_instances.flatMap(i => i.nearby_text || []);   // keep dups for freq
  let detection_config = null;
  try {
    const { types } = discoverCatalog([{
      name:              legend_entry.name,
      nearby_text:       allNearbyText,
      legend_name:       legend_entry.name || null,
      legend_present:    true,                       // came from a legend entry
      approximate_count: instanceCount || null,
      has_symbol:        !!(drawing_crop_base64 || legend_crop_base64),
    }], planTokensFlat, null);
    detection_config = types[0]?.detection_config || null;
    if (detection_config) {
      detection_config.cluster_pt = 25;
      detection_config.source     = 'discovery';
      // family-bearing types (outlets) carry the 1:N leaders; standalone (WAP/180) don't
      detection_config.leader_from_anchor =
        body.leader_from_anchor != null ? !!body.leader_from_anchor
                                        : ((detection_config.families || []).length > 0);
      // optional human overrides from the review UI (fixes the N2-vs-N edge by hand)
      if (body.anchor)      { detection_config.anchor = String(body.anchor).toUpperCase(); detection_config.anchor_confidence = 'high'; }
      if (body.anchor_mode)   detection_config.anchor_mode = body.anchor_mode;
      if (body.families)      detection_config.families   = body.families.map(f => String(f).toUpperCase());
    }
  } catch (e) {
    detection_config = null;   // type still gets created; just not yet detectable
  }

  // Upsert to device_types
  const legend_id = legend_entry.id ||
    `LEG_${legend_entry.name.replace(/[^A-Z0-9]/gi, "_").toUpperCase().slice(0, 30)}`;

  const { data: dt, error: dtErr } = await supabase
    .from("device_types")
    .upsert({
      project_id,
      legend_id,
      name:                 legend_entry.name,
      human_description:    legend_entry.legend_description || legend_entry.short_description || "",
      llm_description,
      text_anchors,
      detection_config,
      example_image_base64: drawing_crop_base64 || legend_crop_base64 || null,
      updated_at:           new Date()
    }, { onConflict: "project_id,legend_id" })
    .select("id")
    .single();

  if (dtErr) return respond(500, { error: "device_types upsert failed: " + dtErr.message });

  return respond(200, {
    device_type_id:  dt.id,
    legend_id,
    name:            legend_entry.name,
    instances_found: instanceCount,
    llm_description,
    text_anchors,
    detection_config
  });
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
