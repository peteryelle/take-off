// public/lib/bom.js
// ─────────────────────────────────────────────────────────────────
// Pure BOM expansion. No DB, no DOM — offline-testable, shared by
// takeoff-summary.js (server rollup) and the browser pipelines.
//
// A counted device is an INPUT to the BOM, not a line item. Each
// instance is expanded through its device type's `assembly` template
// into orderable component parts, then summed across the project.
//
// Assembly shape (on device_types.assembly):
//   { <kind>: [ { qty, part_name, model, manufacturer, device_name,
//                 per_run_ft? }, ... ] }
//
// `kind` is a label FAMILY. The family of a label token is its leading
// alpha run, or — if the token is digits/glyph only — the token itself.
// This reproduces the authored keys exactly: DV1->DV, WAP->WAP, N2->N,
// 180->180.  NOTE: keep labelKind() in sync with asmKindsForDevice()
// in device-types.html (single source of truth for how kinds are cut).
//
// `per_run_ft` (optional, default false) marks a component as the cable
// that connects this device back to its TR/demarc — e.g. the home-run
// cable for a data outlet. Instead of a flat qty per device, its
// effective quantity is `qty * instance.total_ft`, where total_ft is the
// already-computed routed distance (Pass C + demarc stub) for that
// instance. `qty` on a per_run_ft row acts as a multiplier (waste
// factor) — 1 = exact footage, 1.1 = 10% waste allowance — not a count.
// A per_run_ft component on an instance with no total_ft (not yet
// assigned a demarc, or distance never computed) can't be scaled, so it
// is flagged via missing_distance rather than silently contributing 0 —
// the same "brittleness triggers the human, don't silently push through"
// reflex used everywhere else in this pipeline.
// ─────────────────────────────────────────────────────────────────

export function labelKind(token) {
  if (token == null) return null;
  const t = String(token).trim();
  if (!t) return null;
  const m = /^([A-Za-z]+)/.exec(t);   // leading alpha run, if any
  return m ? m[1] : t;                // else the bare token (e.g. "180")
}

// Distinct, order-preserving set of family kinds present on an instance.
export function deviceKinds(rawLabels) {
  const out = [];
  const seen = new Set();
  for (const lbl of rawLabels || []) {
    const k = labelKind(lbl);
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

// Stable aggregation key for a component line.
export function componentKey(c) {
  return [
    (c.manufacturer || '').trim(),
    (c.part_name    || '').trim(),
    (c.model        || '').trim(),
  ].join('\u0001');
}

// Expand ONE instance through ONE assembly.
// Rule: one expansion per modeled family present on the instance.
// Returns { lines, unmodeled, missingDistance } where unmodeled is the
// list of families the instance carries that have no assembly entry at
// all, and missingDistance is the list of families that DO have a
// per_run_ft component but no total_ft to scale it by.
export function expandInstance(instance, assembly) {
  const lines = [];
  const unmodeled = [];
  const missingDistance = [];
  if (instance && instance.removed_by_user) return { lines, unmodeled, missingDistance };

  const asm = assembly || {};
  const kinds = deviceKinds(instance && instance.raw_labels);
  const rawTotalFt = instance && instance.total_ft;
  // Number(null) is 0 (finite!), so null/undefined must be excluded BEFORE
  // the finite check, or a device with no distance yet (not demarc-assigned,
  // distance never computed) silently reads as a real 0ft run instead of
  // triggering missing_distance below.
  const hasDistance = rawTotalFt != null && Number.isFinite(Number(rawTotalFt));
  const totalFt = hasDistance ? Number(rawTotalFt) : null;

  for (const kind of kinds) {
    const comps = asm[kind];
    if (!Array.isArray(comps) || comps.length === 0) {
      unmodeled.push(kind);           // family present, nothing to order
      continue;
    }
    let kindMissingDistance = false;
    for (const c of comps) {
      const qty = Number(c.qty);
      const mult = Number.isFinite(qty) ? qty : (c.per_run_ft ? 1 : 0);
      if (c.per_run_ft) {
        if (!hasDistance) { kindMissingDistance = true; continue; }   // can't scale — skip, don't fabricate a 0-ft cable
        lines.push({
          key:          componentKey(c),
          manufacturer: c.manufacturer || '',
          part_name:    c.part_name    || '',
          model:        c.model        || '',
          device_name:  c.device_name  || '',
          qty:          Math.round(mult * totalFt * 10) / 10,
          kind, per_run_ft: true,
        });
      } else {
        lines.push({
          key:          componentKey(c),
          manufacturer: c.manufacturer || '',
          part_name:    c.part_name    || '',
          model:        c.model        || '',
          device_name:  c.device_name  || '',
          qty:          mult,
          kind, per_run_ft: false,
        });
      }
    }
    if (kindMissingDistance) missingDistance.push(kind);
  }
  return { lines, unmodeled, missingDistance };
}

// Aggregate a whole project's instances into a component-total BOM.
//   instances : array of device_instance rows (raw_labels, device_type_id,
//               removed_by_user, total_ft)
//   typesById : Map or plain object  type_id -> { name, assembly }
// Returns:
//   {
//     components:      [ { manufacturer, part_name, model, device_name, qty } ] sorted,
//     unmodeled:        [ { type_id, name, family, instances } ] sorted,
//     missing_distance: [ { type_id, name, family, instances } ] sorted,
//     coverage:   { total_instances, expanded_instances, flagged_instances }
//   }
export function aggregateBom(instances, typesById, opts = {}) {
  const getType = (id) =>
    typeof typesById?.get === 'function' ? typesById.get(id) : typesById?.[id];

  const totals = new Map();   // componentKey -> aggregated line
  const flags  = new Map();   // `${type_id}\u0001${family}` -> { type_id, name, family, instances }
  const distFlags = new Map();
  let total = 0, expanded = 0, flagged = 0;

  for (const inst of instances || []) {
    if (inst.removed_by_user) continue;
    total++;
    const type = getType(inst.device_type_id) || {};
    const { lines, unmodeled, missingDistance } = expandInstance(inst, type.assembly);

    if (lines.length) expanded++;
    if (unmodeled.length || missingDistance.length) flagged++;

    for (const ln of lines) {
      const agg = totals.get(ln.key);
      if (agg) {
        agg.qty += ln.qty;
      } else {
        totals.set(ln.key, {
          manufacturer: ln.manufacturer,
          part_name:    ln.part_name,
          model:        ln.model,
          device_name:  ln.device_name,
          qty:          ln.qty,
          per_run_ft:   ln.per_run_ft,   // for display units (ft vs ea) — a given
                                          // part identity is consistently one or the
                                          // other, since they're physically different things
        });
      }
    }
    for (const family of unmodeled) {
      const fk = `${inst.device_type_id}\u0001${family}`;
      const f = flags.get(fk);
      if (f) f.instances += 1;
      else flags.set(fk, {
        type_id:   inst.device_type_id,
        name:      type.name || String(inst.device_type_id),
        family,
        instances: 1,
      });
    }
    for (const family of missingDistance) {
      const fk = `${inst.device_type_id}\u0001${family}`;
      const f = distFlags.get(fk);
      if (f) f.instances += 1;
      else distFlags.set(fk, {
        type_id:   inst.device_type_id,
        name:      type.name || String(inst.device_type_id),
        family,
        instances: 1,
      });
    }
  }

  const components = [...totals.values()].sort((a, b) =>
    (a.manufacturer || '').localeCompare(b.manufacturer || '') ||
    (a.part_name    || '').localeCompare(b.part_name    || '') ||
    (a.model        || '').localeCompare(b.model        || ''));

  const unmodeled = [...flags.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '') ||
    (a.family || '').localeCompare(b.family || ''));

  const missing_distance = [...distFlags.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '') ||
    (a.family || '').localeCompare(b.family || ''));

  return {
    components,
    unmodeled,
    missing_distance,
    coverage: { total_instances: total, expanded_instances: expanded, flagged_instances: flagged },
  };
}
