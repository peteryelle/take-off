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
import { buildGreedyPath } from "../../public/lib/waypoint-path.js";
import { toIdentityXY } from "../../public/lib/frame.js";

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

    // ── Scale gate ──────────────────────────────────────────────────
    // Distance (and any TR-run cable line item) silently comes out null
    // when a page has no scale — confirmed on a real project: page 8 had
    // 31 devices correctly detected and TR-assigned, but total_ft stayed
    // null for every one of them because scale was never set, with
    // nothing surfacing the gap until the BOM's missing_distance flag
    // caught it well downstream of the actual cause. Refuse to run
    // detection at all until a scale exists (already on the page, or
    // supplied as scale_override in this request) — brittleness triggers
    // the human immediately, not a silent null discovered three steps
    // later. The scale_override persist block below still runs AFTER
    // this gate on a normal call, so a page can be unblocked by simply
    // supplying scale_override on the next run — no separate save step.
    const hasExistingScale = Number.isFinite(page.scale_pts_per_ft) && page.scale_pts_per_ft > 0;
    const hasOverrideScale = scale_override
      && Number.isFinite(scale_override.paper_value)
      && Number.isFinite(scale_override.real_value)
      && scale_override.real_value > 0;
    if (!hasExistingScale && !hasOverrideScale) {
      await supabase.from("pages").update({
        status: "error",
        status_msg: "Scale not set — set the page scale before running detection"
      }).eq("id", page_id);
      return err("Scale not set for this page — set scale (Pass B, or the manual override) before running detection", 422);
    }

    if (!deviceTypes?.length)
      return err("No device types with detection_config — run discovery or backfill the contract", 404);

    // ── Drawing-bounds filter (label + vector symbol tracks) ────────────
    // Boilerplate text and legend glyphs outside the actual plan area were being
    // detected as real placed devices on every page that carried them — confirmed
    // on a real project: a WAP-symbol legend block got counted as 7+ placed
    // devices, requiring the same hand-culls to be redone on every re-run, since
    // the source was never actually removed. drawing_bounds (captured by Pass B,
    // pages.drawing_x0/y0/x1/y1) marks the real plan area vs. surrounding title
    // block/legend/notes — both in the same identity-frame fraction units as
    // text_items' cx_norm/cy_norm and symbol_instances' x/y, so no conversion
    // needed. Falls back to unfiltered when bounds haven't been captured for this
    // page yet (e.g. Pass B hasn't run) rather than silently dropping everything.
    //
    // Schedule parsing deliberately does NOT use this filter below — a schedule
    // table often sits outside what Pass B considers the "drawing" area, and
    // filtering it the same way would break UIN/cable_dest extraction entirely.
    const db = { x0: page.drawing_x0, y0: page.drawing_y0, x1: page.drawing_x1, y1: page.drawing_y1 };
    const hasDrawingBounds = [db.x0, db.y0, db.x1, db.y1].every((v) => v != null);
    const inDrawingArea = (x, y) => !hasDrawingBounds || (x >= db.x0 && x <= db.x1 && y >= db.y0 && y <= db.y1);

    const labelTextItems = hasDrawingBounds
      ? text_items.filter((t) => inDrawingArea(t.cx_norm, t.cy_norm))
      : text_items;
    const boundedSymbolInstances = hasDrawingBounds
      ? (symbol_instances || []).filter((s) => inDrawingArea(s.x, s.y))
      : (symbol_instances || []);

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

    // Tier 1 cable-routing waypoints (public/lib/waypoint-path.js) — a shared pool for
    // the whole page; the greedy walk below decides per-device whether any are on the
    // way. A page with zero waypoints falls straight back to the exact pre-waypoint
    // straight-line distance (empty pool -> buildGreedyPath returns [device, demarc]).
    const { data: pageWaypoints, error: wpErr } = await supabase
      .from("waypoints").select("id, x_norm, y_norm").eq("page_id", page_id);
    if (wpErr) console.warn("[waypoints fetch]", wpErr.message);
    const waypointsPts = (pageWaypoints ?? [])
      .filter((w) => Number.isFinite(w.x_norm) && Number.isFinite(w.y_norm))
      .map((w) => ({ id: w.id, x: w.x_norm * (page_width_pts ?? 1), y: w.y_norm * (page_height_pts ?? 1) }));

    function euclidPts(cx, cy, pin) {
      const dx = (cx - pin.x_norm) * (page_width_pts  ?? 1);
      const dy = (cy - pin.y_norm) * (page_height_pts ?? 1);
      return Math.sqrt(dx * dx + dy * dy);
    }
    // Routed distance in points: greedy-walks the shared waypoint pool, falling back to
    // the exact euclidPts straight line whenever no waypoint is on the way (or none
    // exist on the page at all) — see buildGreedyPath's header for the algorithm.
    function routedPts(cx, cy, pin) {
      const deviceXY = [cx * (page_width_pts ?? 1), cy * (page_height_pts ?? 1)];
      const demarcXY = [pin.x_norm * (page_width_pts ?? 1), pin.y_norm * (page_height_pts ?? 1)];
      return buildGreedyPath(deviceXY, waypointsPts, demarcXY);
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
      labelTextItems, deviceTypes, page.schedule,
      { scheduleRows: seededScheduleRows, planRegions: scopedPins.map((p) => p.scope_box).filter(Boolean) },
      boundedSymbolInstances, leaderOv);

    // ── Manually-added devices (confidence-map "add missed device") ─────
    // manual_devices is the durable source — re-injected as synthetic reconcile
    // candidates on EVERY run, so a manual add survives device_instances' delete-
    // then-insert wipe below without needing any protective flag on that table.
    // Tagged _manual (internal only — stripped before persisting, see the row
    // build below) so it can bypass the exclude-zone filter (an explicit human
    // placement overrides a general zone rule) and anchor the dedup pass after it.
    const { data: manualRows, error: manualErr } = await supabase
      .from("manual_devices")
      .select("id, device_type_id, x_norm, y_norm, uin")
      .eq("page_id", page_id);
    if (manualErr) console.warn("[manual_devices fetch]", manualErr.message);

    function resolveTypeKey(dt) {
      const cfg = dt.detection_config || {};
      if (cfg.anchor) return cfg.type || dt.name;
      return cfg.symbol_token || cfg.symbol_template?.symbol_token || cfg.type || dt.name;
    }
    for (const m of (manualRows ?? [])) {
      const dt = deviceTypes.find((x) => x.id === m.device_type_id);
      if (!dt) continue;   // type deleted/renamed since the manual add — skip rather than crash the run
      // hasRealUin distinguishes a genuine user-entered UIN from the synthetic
      // `_manual{id}` placeholder below. The placeholder exists only so every
      // manual row has SOME uin value for schedule-join/display purposes — it
      // must never reach raw_labels (see below), or every manually-added device
      // becomes its own unique, unmatchable BOM family (each carries a different
      // id), permanently unable to expand through its type's real assembly even
      // when one exists. See the "Counted but Unmodeled" report investigation.
      const hasRealUin = !!(m.uin && String(m.uin).trim());
      reconciled.push({
        uin: m.uin || `_manual${m.id}`, type: resolveTypeKey(dt),
        x: m.x_norm, y: m.y_norm, xy_source: 'manual', symbol_via: null,
        sources: ['manual'], attributes: { families: [], codes: [] },
        confidence: 'high', flags: ['manual_added'], _manual: true, _hasRealUin: hasRealUin
      });
    }

    // ── Out-of-scope exclusion (hatched zones, kind:'exclude') ──────────
    // Separate mechanism from scopedPins/scope-box distance-routing above: a device
    // inside an exclude region is dropped entirely — never persisted, never counted,
    // never distance-computed. Server-authoritative (queried fresh here, not trusted
    // from the client) so a stale client can't bypass it. Manual adds bypass this —
    // see the block above.
    const { data: excludeRegions, error: exclErr } = await supabase
      .from("page_regions")
      .select("x0, y0, x1, y1")
      .eq("page_id", page_id)
      .eq("kind", "exclude");
    if (exclErr) console.warn("[exclude regions]", exclErr.message);

    // Small automatic buffer on genuinely drawn out-of-scope REGIONS — not the tiny
    // per-device boxes the confidence-map cull flow auto-generates (those stay
    // pixel-precise on purpose, so they don't swallow a nearby device on a dense
    // sheet). A hand-drawn region is rarely pixel-perfect against the true wall/
    // room edge; a device sitting just outside it by a hair is still meant to be
    // excluded, not counted on a technicality. Confirmed on a real project: several
    // rows of devices sat 0.011-0.018 outside a drawn boundary, all along the same
    // wall line — a systematic under-draw, not scattered noise. 0.02 covers that
    // with a little headroom. MIN_REGION_SIZE_FOR_BUFFER distinguishes "region" from
    // "single-device cull box" by size (cull boxes are exactly CULL_PAD_FRAC*2 wide,
    // well under this) rather than needing a schema flag for it.
    const EXCLUDE_ZONE_BUFFER_FRAC = 0.02;
    const MIN_REGION_SIZE_FOR_BUFFER = 0.05;

    // Exclude regions are always stored in the identity (full-page) frame — the
    // client draws them via the SAME bboxForDevice transform normToCanvasXY uses
    // for rendering. But device.x/device.y here are NOT always in that frame:
    // label-sourced (and vector-symbol-sourced) devices are normalized against
    // the page's TEXT-CONTENT bounding box, not the full page. Comparing them
    // directly against an identity-frame box compares two different coordinate
    // spaces — confirmed on a real project: a cull's own exclude box failed to
    // suppress the same device on the very next re-run, with position drift
    // separately ruled out (three consecutive re-runs landed on IDENTICAL
    // coordinates). The content-bbox offset alone (this page: ~0.03, ~-0.03)
    // exceeds a per-device cull box's own half-width, so the mismatch guarantees
    // a miss regardless of how precisely the device re-detects. See frame.js.
    const inExcludeZone = (x, y) => {
      if (x == null || y == null || !excludeRegions?.length) return false;
      return excludeRegions.some((r) => {
        if (r.x0 == null) return false;
        const isRegion = (r.x1 - r.x0) >= MIN_REGION_SIZE_FOR_BUFFER && (r.y1 - r.y0) >= MIN_REGION_SIZE_FOR_BUFFER;
        const buf = isRegion ? EXCLUDE_ZONE_BUFFER_FRAC : 0;
        return x >= r.x0 - buf && x <= r.x1 + buf && y >= r.y0 - buf && y <= r.y1 + buf;
      });
    };
    const excludedCount = reconciled.filter((dev) => {
      if (dev._manual) return false;
      const [ix, iy] = toIdentityXY(dev, content_bbox);
      return inExcludeZone(ix, iy);
    }).length;
    let inScope = reconciled.filter((dev) => {
      if (dev._manual) return true;
      const [ix, iy] = toIdentityXY(dev, content_bbox);
      return !inExcludeZone(ix, iy);
    });

    // Dedup: if detection later genuinely finds the same physical device a manual
    // add already covers (better symbol matching, a schedule row lands, etc.), drop
    // the freshly-detected duplicate rather than double-counting — the manual entry
    // was a confirmed human decision and wins. Compares in identity frame (see
    // frame.js) — manual points are already identity-frame; dev may not be.
    const MANUAL_DEDUP_RADIUS_FRAC = 0.015;
    const manualPoints = inScope.filter((d) => d._manual);
    if (manualPoints.length) {
      inScope = inScope.filter((dev) => {
        if (dev._manual || dev.x == null || dev.y == null) return true;
        const [ix, iy] = toIdentityXY(dev, content_bbox);
        return !manualPoints.some((m) =>
          m.type === dev.type && Math.hypot(ix - m.x, iy - m.y) <= MANUAL_DEDUP_RADIUS_FRAC);
      });
    }

    const instances = inScope.map((dev) => {
      const dt = typeMap[dev.type] || {};
      const fams = dev.attributes?.families || [];
      const codes = dev.attributes?.codes || [];     // full tokens w/ detail # (DV1/DD3)
      const anchor = dt.detection_config?.anchor || null;
      const ports = portsFromFamilies(fams);
      // Transform to identity frame BEFORE any position-based use — assignPin,
      // routedPts, and euclidPts all compare against demarc pins and scope
      // boxes, which are always identity-frame (placed via the pin modal's
      // identity-frame click math). dev.x/dev.y are NOT always identity-frame
      // (label and vector-symbol devices normalize against the content-bbox).
      // This was the same frame-mismatch class fixed for the exclude-zone
      // check earlier tonight, but here it affects EVERY distance value shown
      // for a label-sourced device, not just the exclude-zone gate — a much
      // more foundational bug than tonight's other fixes. See frame.js.
      const [cx, cy] = toIdentityXY(dev, content_bbox);
      const hasXY = cx != null && cy != null;
      // Label: anchor leads (N2), then the detail-numbered family codes in detected order.
      // UIN'd (prefix) types lead with the UIN; standalone (WAP/180) just the type.
      // A manual add without a real UIN (dev._manual && !dev._hasRealUin) must NOT
      // use dev.uin here — that's the internal-only `_manual{id}` placeholder, unique
      // per instance, which would otherwise become its own unmatchable BOM family.
      // Falls through to the same anchor/type label any other UIN-less device gets.
      const useUin = dev.uin && (!dev._manual || dev._hasRealUin);
      const rawLabels = useUin
        ? [dev.uin, ...codes]
        : (codes.length ? (anchor ? [anchor, ...codes] : codes)
                        : (anchor ? [anchor] : [dev.type]));

      const xFt = hasXY && ptsPerFt && page_width_pts  ? parseFloat((cx * page_width_pts  / ptsPerFt).toFixed(1)) : null;
      const yFt = hasXY && ptsPerFt && page_height_pts ? parseFloat((cy * page_height_pts / ptsPerFt).toFixed(1)) : null;

      let demarcId = null, runLengthFt = null, totalFt = null, tiaFlag = false, tiaReason = null, outOfScope = false;
      let routedViaWaypoints = null;
      if (hasXY) {
        const pin = assignPin(cx, cy);
        demarcId  = pin?.demarc_id ?? null;
        outOfScope = scopedPins.length > 0 && !pin;   // scoped page, device inside no box
        if (pin && ptsPerFt) {
          const routed  = routedPts(cx, cy, pin);
          const distPts = routed.total_dist ?? euclidPts(cx, cy, pin);   // defensive: never lose a distance to a malformed route
          if (routed.waypoint_ids_used?.length) routedViaWaypoints = routed.waypoint_ids_used;
          runLengthFt = parseFloat((distPts * ROUTE_FACTOR / ptsPerFt).toFixed(1));
          totalFt     = parseFloat((runLengthFt + (pin.stub_ft ?? 0)).toFixed(1));
          const limit = /WAP/i.test(dt.name || "") ? TIA_WAP_FT : TIA_OUTLET_FT;
          if (totalFt > limit) { tiaFlag = true; tiaReason = `${totalFt}ft exceeds ${limit}ft TIA limit`; }
        }
      }
      const mergedFlags = outOfScope ? [ ...(dev.flags || []), "out_of_scope" ] : (dev.flags || []);

      return {
        dev, dt, routed_via_waypoints: routedViaWaypoints,
        row: {
          page_id, device_type_id: dt.id ?? null, detection_method: dev._manual ? "manual" : "reconciled",
          uin: dev.uin ?? null,
          // ORIGINAL native-frame coordinates, not the identity-transformed
          // cx/cy above — the client applies its own transform on render
          // (bboxForDevice, keyed on xy_source), so persisting the already-
          // transformed value here would double-transform every label-sourced
          // device's displayed position. cx/cy exist ONLY for this function's
          // own position-based math against identity-frame pins/scope-boxes.
          x_norm: hasXY ? parseFloat(dev.x.toFixed(4)) : null,
          y_norm: hasXY ? parseFloat(dev.y.toFixed(4)) : null,
          x_ft: xFt, y_ft: yFt,
          raw_labels: rawLabels,
          data_ports: ports.data_ports, voice_ports: ports.voice_ports, node_labels: ports.node_labels,
          port_count_data: ports.port_count_data, port_count_voice: ports.port_count_voice,
          demarc_id: demarcId, run_length_ft: runLengthFt, total_ft: totalFt,
          tia_flag: tiaFlag, tia_reason: tiaReason, confidence: dev.confidence,
          xy_source: dev.xy_source ?? null,
          symbol_via: dev.symbol_via ?? null,
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
      excluded_out_of_scope: excludedCount,   // dropped by an exclude-kind region — audit visibility only, never persisted
      leader_overrides: leaderOv,   // effective marks (body or persisted) so the UI can pre-fill
      tia_violations: instances.filter((x) => x.row.tia_flag).length,
      max_run_ft: Math.max(0, ...instances.map((x) => x.row.total_ft ?? 0)) || null,
      devices: instances.map((x, j) => ({
        id: inserted?.[j]?.id, device_type_id: x.dt.id ?? null,
        uin: x.dev.uin, type: x.dev.type, legend_id: x.dt.legend_id ?? null, name: x.dt.name ?? x.dev.type,
        x_norm: x.row.x_norm, y_norm: x.row.y_norm, x_ft: x.row.x_ft, y_ft: x.row.y_ft,
        // xy_source tells the client which coordinate FRAME x_norm/y_norm is in —
        // 'label'/'leader' are normalized against the page's text-content bbox,
        // 'symbol' against the full rendered page image (pass-symbol.js's frame).
        // A renderer that ignores this and applies one transform to both will
        // misplace symbol-sourced devices. See confRedraw/lcRedraw in multi-page.html.
        xy_source: x.dev.xy_source,
        symbol_via: x.dev.symbol_via,
        // Ephemeral, not persisted — the path is fully recomputable from persisted
        // device x/y + the page's waypoint pool + the assigned demarc, so a reloaded
        // session recomputes it client-side via buildGreedyPath rather than storing
        // redundant derived state.
        routed_via_waypoints: x.routed_via_waypoints,
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
