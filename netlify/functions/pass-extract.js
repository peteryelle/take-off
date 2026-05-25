// netlify/functions/pass-extract.js
// Pass Extract — Text-layer device detection + label grouping
//
// POST /api/pass-extract
// Body: {
//   project_id,
//   page_id,
//   text_items: [{ str, cx_norm, cy_norm, color_hex, font_size }],
//   page_width_pts,   // PDF native pts width (for scale calc)
//   page_height_pts,
//   scale_pts_per_ft  // calibrated from scale bar (or null → use page scale fields)
// }
//
// text_items come from browser-side PDF.js text extraction.
// Browser pre-filters to device-color text only (~200-400 items per page).
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

// How close (in normalized units) labels must be to cluster together
const CLUSTER_RADIUS_NORM = 0.04;

// TIA-568 limits
const TIA_MAX_PERMANENT_LINK_FT = 295;   // 328ft - 33ft patch allowance
const TIA_MAX_WAP_FT             = 270;   // tighter for WAPs (extra patch cord)

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const {
    project_id,
    page_id,
    text_items,
    page_width_pts,
    page_height_pts,
    scale_pts_per_ft   // pts per real-world foot, null if unknown
  } = body;

  if (!project_id || !page_id || !text_items?.length)
    return err("project_id, page_id and text_items required");

  const supabase = getSupabase();

  // ── Load page (for scale fallback + demarc) ───────────────────
  const [{ data: page, error: pageErr }, { data: deviceTypes, error: devErr }] =
    await Promise.all([
      supabase.from("pages").select("*").eq("id", page_id).single(),
      supabase.from("device_types")
        .select("id, legend_id, name, text_anchors, llm_description")
        .eq("project_id", project_id)
        .not("text_anchors", "is", null)  // only typed devices
    ]);

  if (pageErr || !page)        return err("Page not found", 404);
  if (devErr || !deviceTypes?.length)
    return err("No device types with text_anchors found — run pass-describe first", 404);

  // ── Resolve scale: pts → feet ─────────────────────────────────
  // Priority: caller-supplied > page DB fields > null (coords only)
  const ptsPerFt = scale_pts_per_ft
    ?? (page.scale_paper_in && page.scale_real_ft
        ? (1 / page.scale_paper_in) * (72 * page.scale_real_ft)
        : null);

  // ── Load primary demarc for this page ─────────────────────────
  // Priority: demarcs table (user-set) → pages table (auto-detected by Pass B)
  const { data: demarcs } = await supabase
    .from("demarcs")
    .select("*")
    .eq("project_id", project_id)
    .eq("page_id", page_id)
    .order("created_at");

  let primaryDemarc = demarcs?.[0] ?? null;

  // Fall back to Pass B auto-detected demarc stored in pages table
  if (!primaryDemarc && page?.demarc_x != null) {
    primaryDemarc = {
      id:      null,
      name:    page.demarc_label ?? "auto",
      x_norm:  page.demarc_x,
      y_norm:  page.demarc_y,
      stub_ft: 0,
      source:  "pass_b_auto"
    };
  }

  // ── Build index: primary anchor → device type ─────────────────
  // Each device type specifies primary label strings; we build a fast lookup.
  // Example: { "DD1": deviceType, "DD2": deviceType, "WAP": wapType }
  const anchorIndex = {};   // label → device_type
  for (const dt of deviceTypes) {
    const anchors = dt.text_anchors?.primary ?? [];
    for (const anchor of anchors) {
      // Last writer wins if two device types share an anchor (shouldn't happen)
      anchorIndex[anchor] = dt;
    }
  }

  // ── Assign server-side indices (_idx not sent by browser) ───────
  const indexedItems = text_items.map((t, i) => ({ ...t, _idx: i }));

  // ── Find all items matching a primary anchor ──────────────────
  const primaryItems = indexedItems.filter(t => anchorIndex[t.str.trim()]);

  if (!primaryItems.length) {
    return ok({
      pass:         "extract",
      page_id,
      device_count: 0,
      devices:      [],
      warnings:     ["No primary anchor labels found in text items — check text_anchors on device_types"]
    });
  }

  // ── Cluster: for each primary anchor, gather nearby items ──────
  // Result: one cluster per device instance
  const usedIndices = new Set();
  const clusters    = [];

  for (let i = 0; i < primaryItems.length; i++) {
    const anchor = primaryItems[i];

    // Skip only if this exact item was already claimed as an ASSOCIATED label
    // by a prior cluster. Primary anchors are never claimed — each DD2/WAP
    // is always its own device regardless of proximity.
    if (usedIndices.has(anchor._idx)) continue;

    const dt             = anchorIndex[anchor.str.trim()];
    const primaryAnchors = dt.text_anchors?.primary    ?? [];
    const assocAnchors   = dt.text_anchors?.associated ?? [];

    // Collect nearby ASSOCIATED labels only (DV1, N2, etc.)
    // Do NOT include other primary anchors — each primary = one device
    const clusterItems = indexedItems.filter(t => {
      const dx   = t.cx_norm - anchor.cx_norm;
      const dy   = t.cy_norm - anchor.cy_norm;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return dist <= CLUSTER_RADIUS_NORM
        && assocAnchors.includes(t.str.trim());
    });

    // Mark only ASSOCIATED items as used — prevents them attaching to two devices.
    // Primary anchors are never marked used, so each one always anchors its own device.
    clusterItems.forEach(t => usedIndices.add(t._idx));

    clusters.push({ anchor, device_type: dt, items: clusterItems });
  }

  // ── Build device instances from clusters ──────────────────────
  const instances = clusters.map((cluster, i) => {
    const { anchor, device_type: dt, items } = cluster;
    const anchors = dt.text_anchors ?? {};

    // Collect unique labels
    const labels      = [...new Set(items.map(t => t.str.trim()))];
    const dataLabels  = labels.filter(l => (anchors.primary ?? []).includes(l));
    const voiceLabels = labels.filter(l => (anchors.associated ?? []).some(a => /^DV/.test(a) && l === a));
    const nodeLabels  = labels.filter(l => (anchors.associated ?? []).some(a => /^N\d/.test(a) && l === a));

    // Port count from DD suffix (DD2 → 2, DD3 → 3)
    const portCountData = anchors.label_suffix_is_port_count
      ? Math.max(...dataLabels.map(l => parseInt(l.replace(/\D/g, "")) || 1))
      : dataLabels.length;
    const portCountVoice = voiceLabels.length;

    // Device position = primary anchor position.
    // Associated items (DV1, N2) provide metadata only — not used for centroid.
    const cx = anchor.cx_norm;
    const cy = anchor.cy_norm;

    // Real-world coordinates
    const xFt = ptsPerFt && page_width_pts  ? parseFloat((cx * page_width_pts  / ptsPerFt).toFixed(1)) : null;
    const yFt = ptsPerFt && page_height_pts ? parseFloat((cy * page_height_pts / ptsPerFt).toFixed(1)) : null;

    // Distance to demarc
    let runLengthFt = null;
    let totalFt     = null;
    let tiaFlag     = false;
    let tiaReason   = null;

    if (primaryDemarc?.x_norm != null) {
      const dx   = (cx - primaryDemarc.x_norm) * (page_width_pts  ?? 1);
      const dy   = (cy - primaryDemarc.y_norm) * (page_height_pts ?? 1);
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Route factor 1.35 — cable follows walls, not straight line
      const ROUTE_FACTOR = 1.35;
      if (ptsPerFt) {
        runLengthFt = parseFloat((dist * ROUTE_FACTOR / ptsPerFt).toFixed(1));
        totalFt     = parseFloat((runLengthFt + (primaryDemarc.stub_ft ?? 0)).toFixed(1));

        const limit = /WAP/i.test(dt.name) ? TIA_MAX_WAP_FT : TIA_MAX_PERMANENT_LINK_FT;
        if (totalFt > limit) {
          tiaFlag   = true;
          tiaReason = `${totalFt}ft exceeds TIA ${limit}ft limit`;
        }
      }
    }

    return {
      _cluster_id:     i,
      page_id,
      device_type_id:  dt.id,
      device_name:     dt.name,
      legend_id:       dt.legend_id,
      detection_method: "text_extract",
      x_norm:          parseFloat(cx.toFixed(4)),
      y_norm:          parseFloat(cy.toFixed(4)),
      x_ft:            xFt,
      y_ft:            yFt,
      raw_labels:      labels,
      data_ports:      dataLabels,
      voice_ports:     voiceLabels,
      node_labels:     nodeLabels,
      port_count_data:  portCountData,
      port_count_voice: portCountVoice,
      demarc_id:       primaryDemarc?.id ?? null,
      run_length_ft:   runLengthFt,
      total_ft:        totalFt,
      tia_flag:        tiaFlag,
      tia_reason:      tiaReason,
      confidence:      "high"
    };
  });

  // ── Clear previous results for this page (idempotent) ───────────
  await supabase
    .from("device_instances")
    .delete()
    .eq("page_id", page_id);

  // ── Write to device_instances ─────────────────────────────────
  const dbRows = instances.map(({ _cluster_id, device_name, legend_id, ...row }) => row);

  const { data: inserted, error: insErr } = await supabase
    .from("device_instances")
    .insert(dbRows)
    .select("id, x_norm, y_norm, raw_labels, total_ft, tia_flag");

  if (insErr) return err(`Insert error: ${insErr.message}`, 500);

  // ── Summary ───────────────────────────────────────────────────
  const byType = {};
  for (const inst of instances) {
    const key = inst.legend_id;
    byType[key] = byType[key] ?? { legend_id: key, name: inst.device_name, count: 0, tia: 0 };
    byType[key].count++;
    if (inst.tia_flag) byType[key].tia++;
  }

  const tiaCount    = instances.filter(i => i.tia_flag).length;
  const maxTotal    = instances.reduce((m, i) => Math.max(m, i.total_ft ?? 0), 0);
  const warnings    = [];

  if (tiaCount > 0)
    warnings.push(`${tiaCount} device(s) exceed TIA run limits — review before BOM`);
  if (!ptsPerFt)
    warnings.push("Scale not calibrated — distances not calculated. Set scale in Pass B then re-run.");
  if (!primaryDemarc)
    warnings.push("No demarc set for this page — distances not calculated. Add demarc then re-run.");

  return ok({
    pass:           "extract",
    page_id,
    device_count:   instances.length,
    by_type:        Object.values(byType),
    max_run_ft:     maxTotal || null,
    tia_violations: tiaCount,
    demarc_used:    primaryDemarc
      ? { id: primaryDemarc.id, name: primaryDemarc.name, stub_ft: primaryDemarc.stub_ft }
      : null,
    warnings,
    devices:        instances.map((inst, idx2) => ({
      id:           inserted?.[idx2]?.id,
      legend_id:    inst.legend_id,
      name:         inst.device_name,
      x_norm:       inst.x_norm,
      y_norm:       inst.y_norm,
      x_ft:         inst.x_ft,
      y_ft:         inst.y_ft,
      raw_labels:   inst.raw_labels,
      data_ports:   inst.data_ports,
      voice_ports:  inst.voice_ports,
      node_labels:  inst.node_labels,
      total_ft:     inst.total_ft,
      run_length_ft: inst.run_length_ft,
      tia_flag:     inst.tia_flag,
      tia_reason:   inst.tia_reason
    }))
  });
}

export const config = { path: "/api/pass-extract" };
