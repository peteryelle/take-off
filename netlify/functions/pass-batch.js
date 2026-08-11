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
import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
import { buildDeviceList } from "../../public/lib/pipeline.js";
import { parseSchedule } from "../../public/lib/schedule.js";

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
          scale_override, sheet_class, content_bbox } = body;
  if (!project_id || !page_id || !text_items?.length)
    return err("project_id, page_id and text_items required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);
  await supabase.from("pages").update({ status: "running", status_msg: null }).eq("id", page_id);

  // Persist the client-computed sheet_class probe (substep 4 wiring tail). Passive,
  // best-effort — the client already used it to route the symbol locator; a probe
  // write must never fail the count.
  if (sheet_class && typeof sheet_class === "object") {
    try { await supabase.from("pages").update({ sheet_class }).eq("id", page_id); }
    catch (e) { console.warn("[sheet_class persist]", e?.message); }
  }

  // Persist the content-bbox frame x_norm/y_norm were normalized against (fractions
  // of full page width/height). Without this, any later re-render of the page
  // (confidence map, leader-cluster markup) has no way to reconstruct where
  // x_norm/y_norm=(0,0)-(1,1) actually sits — it silently assumes content bbox ==
  // full page, which drifts on any sheet whose content overflows the MediaBox.
  // Best-effort, same as sheet_class above — a probe write must never fail the count.
  if (content_bbox && typeof content_bbox === "object") {
    try {
      await supabase.from("pages").update({
        content_xmin_frac: content_bbox.xmin_frac ?? null,
        content_ymin_frac: content_bbox.ymin_frac ?? null,
        content_w_frac:    content_bbox.w_frac    ?? null,
        content_h_frac:    content_bbox.h_frac    ?? null
      }).eq("id", page_id);
    } catch (e) { console.warn("[content_bbox persist]", e?.message); }
  }

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
    const scopedPins   = pins.filter((p) => p && p.scope_box);
    const unscopedPins = pins.filter((p) => p && !p.scope_box);

    function euclidPts(cx, cy, pin) {
      const dx = (cx - pin.x_norm) * (page_width_pts  ?? 1);
      const dy = (cy - pin.y_norm) * (page_height_pts ?? 1);
      return Math.sqrt(dx * dx + dy * dy);
    }
    function inBox(b, x, y) { return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; }
    function nearestOf(pool, cx, cy) {
      let best = null, bd = Infinity;
      for (const p of pool) { const d = euclidPts(cx, cy, p); if (d < bd) { bd = d; best = p; } }
      return best;
    }
    // Scope-aware pin assignment. A scoped pin claims only the devices inside its box,
    // so per-box exits measure to the right exit instead of the nearest one. A device in
    // no box on a fully-scoped page is out of scope (null distance — honest blank, not a
    // wrong length). With no scoped pins this reduces to nearest-pin (back-compat: VA and
    // every unboxed page behave exactly as before).
    function assignPin(cx, cy) {
      for (const p of scopedPins) if (inBox(p.scope_box, cx, cy)) return p;
      if (scopedPins.length && !unscopedPins.length) return null;
      return nearestOf(unscopedPins.length ? unscopedPins : pins, cx, cy);
    }

    // ── detect + schedule + symbol → reconcile ──────────────────
    // Overrides come from the body when the client just marked them (and get persisted
    // below), else fall back to whatever was saved on the page. undefined = use saved.
    const leaderOv = (leader_overrides !== undefined) ? leader_overrides : (page.leader_overrides ?? []);

    // ── seed reconcile from the persisted schedule (authoritative device list) ──
    // Only types configured with 'schedule' in their detection sources are seeded,
    // so unconfigured/uncounted classes present in the schedule never become phantom
    // devices. Plan labels join these by UIN; a scheduled type's plan label with no
    // matching schedule UIN is surfaced by reconcile as not_in_schedule (e.g. ALM-1100B).
    const scheduledTypeByPrefix = new Map();   // anchor prefix (UPPER) -> reconcile type key
    for (const dt of deviceTypes) {
      const cfg = dt.detection_config || {};
      if (cfg.anchor && Array.isArray(cfg.sources) && cfg.sources.includes("schedule")) {
        scheduledTypeByPrefix.set(String(cfg.anchor).trim().toUpperCase(), cfg.type || dt.name);
      }
    }
    let seededScheduleRows = [];
    if (scheduledTypeByPrefix.size) {
      const { data: schedRows, error: schedErr } = await supabase
        .from("schedule_rows")
        .select("uin, device_prefix, detail_sheet, cable_dest_1, cable_dest_2")
        .eq("page_id", page_id);
      if (schedErr) console.warn("[schedule_rows load]", schedErr.message);
      seededScheduleRows = (schedRows || []).map((r) => {
        const prefix = String(r.device_prefix || (r.uin || "").split("-")[0] || "").trim().toUpperCase();
        const type = scheduledTypeByPrefix.get(prefix);
        if (!type) return null;                    // unconfigured/uncounted type -> not seeded
        const cable_dest = [r.cable_dest_1, r.cable_dest_2].filter(Boolean);
        return { uin: String(r.uin).trim().toUpperCase(), type,
                 attributes: { cable_dest, detail_sheet: r.detail_sheet || null } };
      }).filter(Boolean);
    }

    // Attach each schedule row's OWN UIN-text coordinate so reconcile can tell a
    // re-detected schedule label (echo — parks the device on the table, off-plan and
    // outside the distance boxes) from a real plan stamp. Derived from the same text
    // layer at run time, so no schema/persist dependency; best-effort and guarded —
    // absent/empty schedule cfg yields no xy, and reconcile's echo guard is then inert
    // (pre-fix behavior). Never affects the count, only which xy a device adopts.
    if (seededScheduleRows.length && page.schedule && page.schedule.present !== false) {
      try {
        const xyByUin = new Map();
        for (const r of parseSchedule(text_items, page.schedule, {})) {
          if (Number.isFinite(r.x) && Number.isFinite(r.y)) xyByUin.set(String(r.uin).trim().toUpperCase(), [r.x, r.y]);
        }
        for (const row of seededScheduleRows) {
          const xy = xyByUin.get(row.uin);
          if (xy) { row.x = xy[0]; row.y = xy[1]; }
        }
      } catch (e) { console.warn("[schedule echo xy]", e?.message); }
    }

    const { devices: reconciled, typeMap } = buildDeviceList(
      text_items, deviceTypes, page.schedule,
      { scheduleRows: seededScheduleRows, planRegions: scopedPins.map((p) => p.scope_box).filter(Boolean) },
      symbol_instances || [], leaderOv);

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

      let demarcId = null, runLengthFt = null, totalFt = null, tiaFlag = false, tiaReason = null, outOfScope = false;
      if (hasXY) {
        const pin = assignPin(cx, cy);
        demarcId  = pin?.demarc_id ?? null;
        outOfScope = scopedPins.length > 0 && !pin;   // scoped page, device inside no box
        if (pin && ptsPerFt) {
          const distPts = euclidPts(cx, cy, pin);
          runLengthFt = parseFloat((distPts * ROUTE_FACTOR / ptsPerFt).toFixed(1));
          totalFt     = parseFloat((runLengthFt + (pin.stub_ft ?? 0)).toFixed(1));
          const limit = /WAP/i.test(dt.name || "") ? TIA_WAP_FT : TIA_OUTLET_FT;
          if (totalFt > limit) { tiaFlag = true; tiaReason = `${totalFt}ft exceeds ${limit}ft TIA limit`; }
        }
      }
      const mergedFlags = outOfScope ? [ ...(dev.flags || []), "out_of_scope" ] : (dev.flags || []);

      return {
        dev, dt,
        row: {
          page_id, device_type_id: dt.id ?? null, detection_method: "reconciled",
          uin: dev.uin ?? null,
          x_norm: hasXY ? parseFloat(cx.toFixed(4)) : null,
          y_norm: hasXY ? parseFloat(cy.toFixed(4)) : null,
          x_ft: xFt, y_ft: yFt,
          raw_labels: rawLabels,
          data_ports: ports.data_ports, voice_ports: ports.voice_ports, node_labels: ports.node_labels,
          port_count_data: ports.port_count_data, port_count_voice: ports.port_count_voice,
          demarc_id: demarcId, run_length_ft: runLengthFt, total_ft: totalFt,
          tia_flag: tiaFlag, tia_reason: tiaReason, confidence: dev.confidence,
          flags: mergedFlags.length ? mergedFlags : null
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
        sources: x.dev.sources, confidence: x.dev.confidence, flags: x.row.flags, attributes: x.dev.attributes,
        total_ft: x.row.total_ft, tia_flag: x.row.tia_flag, tia_reason: x.row.tia_reason, demarc_id: x.row.demarc_id
      }))
    });

  } catch (e) {
    await supabase.from("pages").update({ status: "error", status_msg: e.message }).eq("id", page_id);
    return err(e.message, 500);
  }
}

export const config = { path: "/api/pass-batch" };
