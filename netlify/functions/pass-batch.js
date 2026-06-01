// netlify/functions/pass-batch.js
// Batch runner — one page at a time (browser orchestrates the sequence).
//
// POST /api/pass-batch
// Body: { project_id, page_id, eval_page_num, text_items,
//         page_width_pts, page_height_pts,
//         demarc_pins: [{ demarc_id, x_norm, y_norm, name, stub_ft }] }
//
// detect + schedule -> reconcile (public/lib/pipeline.js); distance is computed
// per reconciled device against the nearest demarc pin.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { buildDeviceList } from "../../public/lib/pipeline.js";

const ROUTE_FACTOR  = 1.35;
const TIA_OUTLET_FT = 295;
const TIA_WAP_FT    = 270;

function portsFromFamilies(fams = []) {
  const F = fams.map((f) => String(f).toUpperCase());
  const data = F.filter((f) => f === "DD");
  const voice = F.filter((f) => f === "DV");
  const node = F.filter((f) => f === "N");
  return { data_ports: data, voice_ports: voice, node_labels: node,
           port_count_data: data.length, port_count_voice: voice.length };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id, eval_page_num, text_items,
          page_width_pts, page_height_pts, demarc_pins, symbol_instances, leader_overrides,
          scale_override } = body;
  if (!project_id || !page_id || !text_items?.length)
    return err("project_id, page_id and text_items required");

  const supabase = getSupabase();
  await supabase.from("pages").update({ status: "running", status_msg: null }).eq("id", page_id);

  try {
    const [{ data: page }, { data: deviceTypes }] = await Promise.all([
      supabase.from("pages").select("*").eq("id", page_id).single(),
      supabase.from("device_types")
        .select("id, legend_id, name, detection_config")
        .eq("project_id", project_id)
        .not("detection_config", "is", null)
    ]);

    if (!page) return err("Page not found", 404);
    if (!deviceTypes?.length)
      return err("No device types with detection_config — run discovery or backfill the contract", 404);

    // Scale override from the per-page editor: persist to the page row (so distances
    // use it and it survives reload; redo replaces), then read it back for this run.
    if (scale_override && Number.isFinite(scale_override.paper_value) && Number.isFinite(scale_override.real_value) && scale_override.real_value > 0) {
      const ptsPer = (72 * scale_override.paper_value) / scale_override.real_value;
      await supabase.from("pages").update({
        scale_paper_in:   scale_override.paper_value,
        scale_real_ft:    scale_override.real_value,
        scale_pts_per_ft: ptsPer,
        scale_label:      `${scale_override.paper_value}" = ${scale_override.real_value}'`
      }).eq("id", page_id);
      page.scale_pts_per_ft = ptsPer;   // use immediately
    }

    const ptsPerFt = page.scale_pts_per_ft ?? null;
    const pins = demarc_pins ?? [];

    function nearestPin(cx, cy) {
      if (!pins.length) return null;
      let best = null, bestDist = Infinity;
      for (const pin of pins) {
        const dx = (cx - pin.x_norm) * (page_width_pts  ?? 1);
        const dy = (cy - pin.y_norm) * (page_height_pts ?? 1);
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; best = pin; }
      }
      return { pin: best, dist_pts: bestDist };
    }

    // ── detect + schedule + symbol → reconcile ──────────────────
    // Overrides come from the body when the client just marked them (and get persisted
    // below), else fall back to whatever was saved on the page. undefined = use saved.
    const leaderOv = (leader_overrides !== undefined) ? leader_overrides : (page.leader_overrides ?? []);
    const { devices: reconciled, typeMap } = buildDeviceList(text_items, deviceTypes, page.schedule, {}, symbol_instances || [], leaderOv);

    const instances = reconciled.map((dev) => {
      const dt = typeMap[dev.type] || {};
      const fams = dev.attributes?.families || [];
      const codes = dev.attributes?.codes || [];     // full tokens w/ detail # (DV1/DD3)
      const anchor = dt.detection_config?.anchor || null;
      const ports = portsFromFamilies(fams);
      const cx = dev.x, cy = dev.y;
      const hasXY = cx != null && cy != null;
      // Label: anchor leads (N2), then the detail-numbered family codes in detected order.
      // UIN'd (prefix) types lead with the UIN; standalone (WAP/180) just the type.
      const rawLabels = dev.uin
        ? [dev.uin, ...codes]
        : (codes.length ? (anchor ? [anchor, ...codes] : codes)
                        : (anchor ? [anchor] : [dev.type]));

      const xFt = hasXY && ptsPerFt && page_width_pts  ? parseFloat((cx * page_width_pts  / ptsPerFt).toFixed(1)) : null;
      const yFt = hasXY && ptsPerFt && page_height_pts ? parseFloat((cy * page_height_pts / ptsPerFt).toFixed(1)) : null;

      let demarcId = null, runLengthFt = null, totalFt = null, tiaFlag = false, tiaReason = null;
      if (hasXY) {
        const pinResult = nearestPin(cx, cy);
        demarcId = pinResult?.pin?.demarc_id ?? null;
        if (pinResult?.pin && ptsPerFt) {
          runLengthFt = parseFloat((pinResult.dist_pts * ROUTE_FACTOR / ptsPerFt).toFixed(1));
          totalFt     = parseFloat((runLengthFt + (pinResult.pin.stub_ft ?? 0)).toFixed(1));
          const limit = /WAP/i.test(dt.name || "") ? TIA_WAP_FT : TIA_OUTLET_FT;
          if (totalFt > limit) { tiaFlag = true; tiaReason = `${totalFt}ft exceeds ${limit}ft TIA limit`; }
        }
      }

      return {
        dev, dt,
        row: {
          page_id, device_type_id: dt.id ?? null, detection_method: "reconciled",
          x_norm: hasXY ? parseFloat(cx.toFixed(4)) : null,
          y_norm: hasXY ? parseFloat(cy.toFixed(4)) : null,
          x_ft: xFt, y_ft: yFt,
          raw_labels: rawLabels,
          data_ports: ports.data_ports, voice_ports: ports.voice_ports, node_labels: ports.node_labels,
          port_count_data: ports.port_count_data, port_count_voice: ports.port_count_voice,
          demarc_id: demarcId, run_length_ft: runLengthFt, total_ft: totalFt,
          tia_flag: tiaFlag, tia_reason: tiaReason, confidence: dev.confidence,
          flags: (dev.flags && dev.flags.length) ? dev.flags : null
        }
      };
    });

    await supabase.from("device_instances").delete().eq("page_id", page_id);
    const { data: inserted, error: insErr } = await supabase
      .from("device_instances").insert(instances.map((x) => x.row)).select("id");
    if (insErr) throw new Error(`Insert error: ${insErr.message}`);

    const needsPlacement = instances.filter((x) => x.dev.flags?.includes("needs_placement")).length;
    const unlabeledSym   = instances.filter((x) => x.dev.flags?.includes("no_uin")).length;
    const bits = [`${instances.length} devices`];
    if (needsPlacement) bits.push(`${needsPlacement} need placement`);
    if (unlabeledSym)   bits.push(`${unlabeledSym} unlabeled symbol(s)`);
    const doneMsg = bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(", ")})` : `${bits[0]} found`;
    const pageUpdate = { status: "done", status_msg: doneMsg };
    if (leader_overrides !== undefined) pageUpdate.leader_overrides = leader_overrides;  // redo replaces
    await supabase.from("pages").update(pageUpdate).eq("id", page_id);

    const byType = {};
    for (const { dt, dev, row } of instances) {
      const k = dt.legend_id ?? dev.type;
      byType[k] = byType[k] ?? { legend_id: dt.legend_id ?? null, name: dt.name ?? dev.type, count: 0, tia: 0 };
      byType[k].count++;
      if (row.tia_flag) byType[k].tia++;
    }

    return ok({
      pass: "batch_page", page_id, eval_page_num,
      device_count: instances.length, by_type: Object.values(byType),
      leader_overrides: leaderOv,   // effective marks (body or persisted) so the UI can pre-fill
      tia_violations: instances.filter((x) => x.row.tia_flag).length,
      max_run_ft: Math.max(0, ...instances.map((x) => x.row.total_ft ?? 0)) || null,
      devices: instances.map((x, j) => ({
        id: inserted?.[j]?.id, device_type_id: x.dt.id ?? null,
        uin: x.dev.uin, type: x.dev.type, legend_id: x.dt.legend_id ?? null, name: x.dt.name ?? x.dev.type,
        x_norm: x.row.x_norm, y_norm: x.row.y_norm, x_ft: x.row.x_ft, y_ft: x.row.y_ft,
        raw_labels: x.row.raw_labels,
        sources: x.dev.sources, confidence: x.dev.confidence, flags: x.dev.flags, attributes: x.dev.attributes,
        total_ft: x.row.total_ft, tia_flag: x.row.tia_flag, tia_reason: x.row.tia_reason, demarc_id: x.row.demarc_id
      }))
    });

  } catch (e) {
    await supabase.from("pages").update({ status: "error", status_msg: e.message }).eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/pass-batch" };
