// netlify/functions/pass-extract.js
// Pass Extract — v2 reconciled detection.
//
// POST /api/pass-extract
// Body: { project_id, page_id, text_items, page_width_pts, page_height_pts,
//         scale_pts_per_ft, clear_only }
//
// detect + schedule -> reconcile (public/lib/pipeline.js). The pipeline emits one
// device record per physical device; this function recovers type metadata,
// computes distance/TIA per reconciled device, persists, and returns the list.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { buildDeviceList } from "../../public/lib/pipeline.js";

const TIA_MAX_PERMANENT_LINK_FT = 295;
const TIA_MAX_WAP_FT             = 270;
const ROUTE_FACTOR              = 1.35;

// Coarse port breakdown from reconcile's family prefixes (precise BOM is Step 9).
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

  const { project_id, page_id, text_items, page_width_pts, page_height_pts, scale_pts_per_ft, clear_only,
          symbol_instances, leader_overrides } = body;
  if (!project_id || !page_id) return err("project_id and page_id required");

  const supabase = getSupabase();

  if (clear_only) {
    await supabase.from("device_instances").delete().eq("page_id", page_id);
    return ok({ pass: "extract", page_id, cleared: true, device_count: 0, devices: [], warnings: [] });
  }
  if (!text_items?.length) return err("text_items required");

  const [{ data: page, error: pageErr }, { data: deviceTypes, error: devErr }] =
    await Promise.all([
      supabase.from("pages").select("*").eq("id", page_id).single(),
      supabase.from("device_types")
        .select("id, legend_id, name, detection_config")
        .eq("project_id", project_id)
        .not("detection_config", "is", null)
    ]);

  if (pageErr || !page) return err("Page not found", 404);
  if (devErr || !deviceTypes?.length)
    return err("No device types with detection_config — run discovery or backfill the contract", 404);

  const ptsPerFt = scale_pts_per_ft
    ?? (page.scale_paper_in && page.scale_real_ft
        ? (1 / page.scale_paper_in) * (72 * page.scale_real_ft)
        : null);

  // Primary demarc: demarcs table (user-set) → pages auto-detected (Pass B)
  const { data: demarcs } = await supabase
    .from("demarcs").select("*")
    .eq("project_id", project_id).eq("page_id", page_id).order("created_at");
  let primaryDemarc = demarcs?.[0] ?? null;
  if (!primaryDemarc && page?.demarc_x != null) {
    primaryDemarc = { id: null, name: page.demarc_label ?? "auto",
                      x_norm: page.demarc_x, y_norm: page.demarc_y, stub_ft: 0, source: "pass_b_auto" };
  }

  // ── detect + schedule + symbol → reconcile ────────────────────
  // Symbols (from /api/pass-symbol) fold onto labeled/scheduled devices in SNAP and
  // surface genuinely unlabeled glyphs; [] when the caller ran no symbol detection.
  const { devices: reconciled, typeMap } = buildDeviceList(text_items, deviceTypes, page.schedule, {}, symbol_instances || [], leader_overrides || []);

  if (!reconciled.length) {
    return ok({ pass: "extract", page_id, device_count: 0, devices: [],
                warnings: ["No devices reconciled — check detection_config anchors and the schedule locator"] });
  }

  // ── Map reconciled devices → rows (distance/TIA per device) ────
  const instances = reconciled.map((dev) => {
    const dt = typeMap[dev.type] || {};
    const fams = dev.attributes?.families || [];
    const ports = portsFromFamilies(fams);
    const cx = dev.x, cy = dev.y;
    const hasXY = cx != null && cy != null;
    const rawLabels = dev.uin ? [dev.uin, ...fams] : (fams.length ? fams : [dev.type]);

    const xFt = hasXY && ptsPerFt && page_width_pts  ? parseFloat((cx * page_width_pts  / ptsPerFt).toFixed(1)) : null;
    const yFt = hasXY && ptsPerFt && page_height_pts ? parseFloat((cy * page_height_pts / ptsPerFt).toFixed(1)) : null;

    let runLengthFt = null, totalFt = null, tiaFlag = false, tiaReason = null;
    if (hasXY && primaryDemarc?.x_norm != null && ptsPerFt) {
      const dx = (cx - primaryDemarc.x_norm) * (page_width_pts  ?? 1);
      const dy = (cy - primaryDemarc.y_norm) * (page_height_pts ?? 1);
      const dist = Math.sqrt(dx * dx + dy * dy);
      runLengthFt = parseFloat((dist * ROUTE_FACTOR / ptsPerFt).toFixed(1));
      totalFt     = parseFloat((runLengthFt + (primaryDemarc.stub_ft ?? 0)).toFixed(1));
      const limit = /WAP/i.test(dt.name || "") ? TIA_MAX_WAP_FT : TIA_MAX_PERMANENT_LINK_FT;
      if (totalFt > limit) { tiaFlag = true; tiaReason = `${totalFt}ft exceeds TIA ${limit}ft limit`; }
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
        demarc_id: primaryDemarc?.id ?? null,
        run_length_ft: runLengthFt, total_ft: totalFt, tia_flag: tiaFlag, tia_reason: tiaReason,
        confidence: dev.confidence
      }
    };
  });

  // ── Clear previous results for this page (idempotent) ──────────
  await supabase.from("device_instances").delete().eq("page_id", page_id);
  if (page?.pdf_page_number) {
    const { data: siblingPages } = await supabase
      .from("pages").select("id")
      .eq("project_id", project_id).eq("pdf_page_number", page.pdf_page_number).neq("id", page_id);
    if (siblingPages?.length) {
      await supabase.from("device_instances").delete().in("page_id", siblingPages.map((p) => p.id));
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .from("device_instances").insert(instances.map((x) => x.row))
    .select("id, x_norm, y_norm, total_ft, tia_flag");
  if (insErr) return err(`Insert error: ${insErr.message}`, 500);

  // ── Summary ────────────────────────────────────────────────────
  const byType = {};
  for (const { dt, dev, row } of instances) {
    const key = dt.legend_id ?? dev.type;
    byType[key] = byType[key] ?? { legend_id: dt.legend_id ?? null, name: dt.name ?? dev.type, count: 0, tia: 0 };
    byType[key].count++;
    if (row.tia_flag) byType[key].tia++;
  }
  const tiaCount = instances.filter((x) => x.row.tia_flag).length;
  const maxTotal = instances.reduce((m, x) => Math.max(m, x.row.total_ft ?? 0), 0);
  const needsPlacement = instances.filter((x) => x.dev.flags?.includes("needs_placement")).length;
  const unlabeledSym   = instances.filter((x) => x.dev.flags?.includes("no_uin")).length;
  const inferredPlaced = instances.filter((x) => x.dev.flags?.includes("placement_inferred")).length;
  const leaderExpanded = instances.filter((x) => x.dev.flags?.includes("leader_expanded")).length;

  const warnings = [];
  if (tiaCount > 0)      warnings.push(`${tiaCount} device(s) exceed TIA run limits — review before BOM`);
  if (!ptsPerFt)        warnings.push("Scale not calibrated — distances not calculated. Set scale in Pass B then re-run.");
  if (!primaryDemarc)   warnings.push("No demarc set for this page — distances not calculated. Add demarc then re-run.");
  if (needsPlacement)   warnings.push(`${needsPlacement} scheduled device(s) need a placement (no label/symbol matched).`);
  if (unlabeledSym)     warnings.push(`${unlabeledSym} unlabeled symbol(s) found with no UIN — review and confirm or discard.`);
  if (inferredPlaced)   warnings.push(`${inferredPlaced} scheduled device(s) placed by symbol only (UIN binding inferred) — verify location.`);
  if (leaderExpanded)   warnings.push(`${leaderExpanded} device(s) from 1:N leader overrides — count is estimator-asserted, distance measured from the reference cluster.`);

  return ok({
    pass: "extract", page_id, device_count: instances.length,
    by_type: Object.values(byType), max_run_ft: maxTotal || null, tia_violations: tiaCount,
    demarc_used: primaryDemarc ? { id: primaryDemarc.id, name: primaryDemarc.name, stub_ft: primaryDemarc.stub_ft } : null,
    warnings,
    devices: instances.map((x, idx) => ({
      id: inserted?.[idx]?.id,
      uin: x.dev.uin, type: x.dev.type, name: x.dt.name ?? x.dev.type, legend_id: x.dt.legend_id ?? null,
      x_norm: x.row.x_norm, y_norm: x.row.y_norm, x_ft: x.row.x_ft, y_ft: x.row.y_ft,
      raw_labels: x.row.raw_labels,
      sources: x.dev.sources, confidence: x.dev.confidence, flags: x.dev.flags,
      attributes: x.dev.attributes,
      total_ft: x.row.total_ft, run_length_ft: x.row.run_length_ft,
      tia_flag: x.row.tia_flag, tia_reason: x.row.tia_reason
    }))
  });
}

export const config = { path: "/api/pass-extract" };
