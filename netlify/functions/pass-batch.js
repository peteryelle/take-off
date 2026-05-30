// netlify/functions/pass-batch.js
// Batch runner — processes one page at a time
// Called repeatedly by the browser (one call per page)
// Browser orchestrates the sequence; this function handles one page
//
// POST /api/pass-batch
// Body: {
//   project_id,
//   page_id,          -- DB page record id
//   eval_page_num,    -- PDF page number
//   text_items,       -- from browser PDF.js extraction
//   page_width_pts,
//   page_height_pts,
//   demarc_pins: [    -- all pins for this page (from demarc config)
//     { demarc_id, x_norm, y_norm, name, stub_ft }
//   ]
// }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

const CLUSTER_RADIUS_NORM  = 0.04;
const ROUTE_FACTOR         = 1.35;
const TIA_OUTLET_FT        = 295;
const TIA_WAP_FT           = 270;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const {
    project_id, page_id, eval_page_num,
    text_items, page_width_pts, page_height_pts,
    demarc_pins
  } = body;

  if (!project_id || !page_id || !text_items?.length)
    return err("project_id, page_id and text_items required");

  const supabase = getSupabase();

  // ── Mark page as running ──────────────────────────────────────
  await supabase.from("pages")
    .update({ status: 'running', status_msg: null })
    .eq("id", page_id);

  try {
    // ── Load page + device types ──────────────────────────────────
    const [{ data: page }, { data: deviceTypes }] = await Promise.all([
      supabase.from("pages").select("*").eq("id", page_id).single(),
      supabase.from("device_types")
        .select("id, legend_id, name, text_anchors")
        .eq("project_id", project_id)
        .not("text_anchors", "is", null)
    ]);

    if (!page)         return err("Page not found", 404);
    if (!deviceTypes?.length)
      return err("No device types with text_anchors", 404);

    const ptsPerFt = page.scale_pts_per_ft ?? null;

    // ── Build anchor index ────────────────────────────────────────
    const anchorIndex = {};
    for (const dt of deviceTypes) {
      for (const anchor of (dt.text_anchors?.primary ?? [])) {
        anchorIndex[anchor] = dt;
      }
    }

    // ── Index text items ──────────────────────────────────────────
    const indexedItems = text_items.map((t, i) => ({ ...t, _idx: i }));
    const primaryItems = indexedItems.filter(t => anchorIndex[t.str?.trim()]);

    // ── Cluster into device instances ─────────────────────────────
    const usedIndices = new Set();
    const clusters    = [];

    for (const anchor of primaryItems) {
      if (usedIndices.has(anchor._idx)) continue;

      const dt         = anchorIndex[anchor.str.trim()];
      const assocAnchors = dt.text_anchors?.associated ?? [];

      const clusterItems = indexedItems.filter(t => {
        const dx   = t.cx_norm - anchor.cx_norm;
        const dy   = t.cy_norm - anchor.cy_norm;
        return Math.sqrt(dx*dx + dy*dy) <= CLUSTER_RADIUS_NORM
          && assocAnchors.includes(t.str?.trim());
      });

      clusterItems.forEach(t => usedIndices.add(t._idx));
      clusters.push({ anchor, device_type: dt, items: clusterItems });
    }

    // ── Resolve demarc per device (nearest pin) ───────────────────
    const pins = demarc_pins ?? [];

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

    // ── Build device instances ────────────────────────────────────
    const instances = clusters.map((cluster, i) => {
      const { anchor, device_type: dt, items } = cluster;
      const labels      = [...new Set([anchor.str.trim(), ...items.map(t => t.str.trim())])];
      const anchors     = dt.text_anchors ?? {};
      const dataLabels  = labels.filter(l => (anchors.primary ?? []).includes(l));
      const voiceLabels = labels.filter(l => (anchors.associated ?? []).some(a => /^DV/.test(a) && l === a));
      const nodeLabels  = labels.filter(l => (anchors.associated ?? []).some(a => /^N\d/.test(a) && l === a));

      const portCountData  = anchors.label_suffix_is_port_count
        ? Math.max(...dataLabels.map(l => parseInt(l.replace(/\D/g,'')) || 1))
        : dataLabels.length;

      const cx = anchor.cx_norm;
      const cy = anchor.cy_norm;
      const xFt = ptsPerFt && page_width_pts
        ? parseFloat((cx * page_width_pts / ptsPerFt).toFixed(1)) : null;
      const yFt = ptsPerFt && page_height_pts
        ? parseFloat((cy * page_height_pts / ptsPerFt).toFixed(1)) : null;

      // Demarc + distance
      const pinResult = nearestPin(cx, cy);
      let demarcId    = pinResult?.pin?.demarc_id ?? null;
      let runLengthFt = null;
      let totalFt     = null;
      let tiaFlag     = false;
      let tiaReason   = null;

      if (pinResult?.pin && ptsPerFt) {
        runLengthFt = parseFloat(
          (pinResult.dist_pts * ROUTE_FACTOR / ptsPerFt).toFixed(1)
        );
        totalFt = parseFloat(
          (runLengthFt + (pinResult.pin.stub_ft ?? 0)).toFixed(1)
        );
        const limit = /WAP/i.test(dt.name) ? TIA_WAP_FT : TIA_OUTLET_FT;
        if (totalFt > limit) {
          tiaFlag   = true;
          tiaReason = `${totalFt}ft exceeds ${limit}ft TIA limit`;
        }
      }

      return {
        page_id,
        device_type_id:  dt.id,
        detection_method: 'text_extract',
        x_norm:          parseFloat(cx.toFixed(4)),
        y_norm:          parseFloat(cy.toFixed(4)),
        x_ft:            xFt,
        y_ft:            yFt,
        raw_labels:      labels,
        data_ports:      dataLabels,
        voice_ports:     voiceLabels,
        node_labels:     nodeLabels,
        port_count_data:  portCountData,
        port_count_voice: voiceLabels.length,
        demarc_id:       demarcId,
        run_length_ft:   runLengthFt,
        total_ft:        totalFt,
        tia_flag:        tiaFlag,
        tia_reason:      tiaReason,
        confidence:      'high',
        // for response only
        _name:           dt.name,
        _legend_id:      dt.legend_id
      };
    });

    // ── Replace existing instances for this page ──────────────────
    await supabase.from("device_instances")
      .delete().eq("page_id", page_id);

    const dbRows = instances.map(({ _name, _legend_id, ...row }) => row);

    const { data: inserted, error: insErr } = await supabase
      .from("device_instances")
      .insert(dbRows)
      .select("id");

    if (insErr) throw new Error(`Insert error: ${insErr.message}`);

    // ── Mark page done ────────────────────────────────────────────
    await supabase.from("pages")
      .update({ status: 'done', status_msg: `${instances.length} devices found` })
      .eq("id", page_id);

    // ── Summary ───────────────────────────────────────────────────
    const byType = {};
    for (const inst of instances) {
      const k = inst._legend_id ?? 'unknown';
      byType[k] = byType[k] ?? { legend_id: k, name: inst._name, count: 0, tia: 0 };
      byType[k].count++;
      if (inst.tia_flag) byType[k].tia++;
    }

    return ok({
      pass:          "batch_page",
      page_id,
      eval_page_num,
      device_count:  instances.length,
      by_type:       Object.values(byType),
      tia_violations: instances.filter(i => i.tia_flag).length,
      max_run_ft:    Math.max(0, ...instances.map(i => i.total_ft ?? 0)) || null,
      devices:       instances.map((inst, j) => ({
        id:            inserted?.[j]?.id,
        device_type_id: inst.device_type_id,
        legend_id:     inst._legend_id,
        name:          inst._name,
        x_norm:       inst.x_norm,
        y_norm:       inst.y_norm,
        x_ft:         inst.x_ft,
        y_ft:         inst.y_ft,
        raw_labels:   inst.raw_labels,
        data_ports:   inst.data_ports,
        voice_ports:  inst.voice_ports,
        node_labels:  inst.node_labels,
        total_ft:     inst.total_ft,
        tia_flag:     inst.tia_flag,
        tia_reason:   inst.tia_reason,
        demarc_id:    inst.demarc_id
      }))
    });

  } catch(e) {
    // Mark page as error
    await supabase.from("pages")
      .update({ status: 'error', status_msg: e.message })
      .eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/pass-batch" };
