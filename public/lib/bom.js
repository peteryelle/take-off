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
//   { <kind>: [ { qty, part_name, model, manufacturer, device_name }, ... ] }
//
// `kind` is a label FAMILY. The family of a label token is its leading
// alpha run, or — if the token is digits/glyph only — the token itself.
// This reproduces the authored keys exactly: DV1->DV, WAP->WAP, N2->N,
// 180->180.  NOTE: keep labelKind() in sync with asmKindsForDevice()
// in device-types.html (single source of truth for how kinds are cut).
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
// Returns { lines, unmodeled } where unmodeled is the list of families
// the instance carries that have no assembly entry (coverage flags).
export function expandInstance(instance, assembly) {
  const lines = [];
  const unmodeled = [];
  if (instance && instance.removed_by_user) return { lines, unmodeled };

  const asm = assembly || {};
  const kinds = deviceKinds(instance && instance.raw_labels);

  for (const kind of kinds) {
    const comps = asm[kind];
    if (!Array.isArray(comps) || comps.length === 0) {
      unmodeled.push(kind);           // family present, nothing to order
      continue;
    }
    for (const c of comps) {
      const qty = Number(c.qty);
      lines.push({
        key:          componentKey(c),
        manufacturer: c.manufacturer || '',
        part_name:    c.part_name    || '',
        model:        c.model        || '',
        device_name:  c.device_name  || '',
        qty:          Number.isFinite(qty) ? qty : 0,
        kind,
      });
    }
  }
  return { lines, unmodeled };
}

// Aggregate a whole project's instances into a component-total BOM.
//   instances : array of device_instance rows (raw_labels, device_type_id, removed_by_user)
//   typesById : Map or plain object  type_id -> { name, assembly }
// Returns:
//   {
//     components: [ { manufacturer, part_name, model, device_name, qty } ] sorted,
//     unmodeled:  [ { type_id, name, family, instances } ] sorted,
//     coverage:   { total_instances, expanded_instances, flagged_instances }
//   }
export function aggregateBom(instances, typesById, opts = {}) {
  const getType = (id) =>
    typeof typesById?.get === 'function' ? typesById.get(id) : typesById?.[id];

  const totals = new Map();   // componentKey -> aggregated line
  const flags  = new Map();   // `${type_id}\u0001${family}` -> { type_id, name, family, instances }
  let total = 0, expanded = 0, flagged = 0;

  for (const inst of instances || []) {
    if (inst.removed_by_user) continue;
    total++;
    const type = getType(inst.device_type_id) || {};
    const { lines, unmodeled } = expandInstance(inst, type.assembly);

    if (lines.length) expanded++;
    if (unmodeled.length) flagged++;

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
  }

  const components = [...totals.values()].sort((a, b) =>
    (a.manufacturer || '').localeCompare(b.manufacturer || '') ||
    (a.part_name    || '').localeCompare(b.part_name    || '') ||
    (a.model        || '').localeCompare(b.model        || ''));

  const unmodeled = [...flags.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '') ||
    (a.family || '').localeCompare(b.family || ''));

  return {
    components,
    unmodeled,
    coverage: { total_instances: total, expanded_instances: expanded, flagged_instances: flagged },
  };
}
