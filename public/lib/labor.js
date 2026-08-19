// public/lib/labor.js
// ─────────────────────────────────────────────────────────────────
// Pure labor-hours expansion. Mirrors public/lib/bom.js in structure and
// philosophy — a counted device is expanded through its device type's
// `labor` template (device_types.labor jsonb, kept separate from
// `assembly`/material) into task-hour lines, summed across the project.
//
// HOURS ONLY. Converting hours to dollars needs a $/hr rate, which is a
// deliberate separate step not wired up here. The hours-per-device-type
// number itself is an engineering judgment call the person enters
// directly (informed by a reference rate sheet), not something derived
// or verified by this module — same trust model as picking a material
// part: the app applies what you entered, it doesn't validate it.
//
// Labor shape (on device_types.labor):
//   { <kind>: [ { task_name, hrs, setup_hrs, qty?, per_run_ft? }, ... ] }
//
// `kind` is the same label-family key used for material (labelKind() in
// bom.js) — a device type's "2D" kind can carry different labor tasks
// than its "4D" kind, same as material components.
//
// `qty` (optional, default 1) works exactly like material's qty: a flat
// count multiplier (e.g. 2 terminations for a 2-port device), or a
// waste-factor-style multiplier on a per_run_ft task.
//
// `per_run_ft` marks a task as scaling with the device's routed distance
// (e.g. cable-pull hours): effective hours = hrs * qty * total_ft +
// setup_hrs. A flat (non-per_run_ft) task's hours = hrs * qty +
// setup_hrs per instance — setup is incurred once per instance either
// way, not scaled by footage or qty, mirroring the source rate sheet's
// J = (qty*H) + I pattern.
//
// Unlike material, an empty/missing labor entry for a kind is NOT
// flagged — labor is new and most device types won't have it populated
// yet, and treating that as a data-quality problem would just be noise.
// The one real gap that IS flagged: a per_run_ft task on an instance
// with no total_ft yet, which genuinely can't be scaled — same
// brittleness-triggers-the-human reflex as the material side.
// ─────────────────────────────────────────────────────────────────

import { labelKind } from './bom.js';

function taskKey(t) {
  return (t.task_name || '').trim();
}

function expandInstanceLabor(inst, labor) {
  const lines = [];
  const missingDistance = [];
  if (!labor || typeof labor !== 'object') return { lines, missingDistance };

  const labels  = Array.isArray(inst.raw_labels) ? inst.raw_labels : [];
  const totalFt = Number(inst.total_ft);
  const hasDistance = Number.isFinite(totalFt) && totalFt > 0;

  const kinds = new Set(labels.map(labelKind).filter(Boolean));
  if (!kinds.size) kinds.add('__default__');

  for (const kind of kinds) {
    const tasks = Array.isArray(labor[kind]) ? labor[kind] : null;
    if (!tasks) continue;   // no labor defined for this kind yet — not a flagged gap, just nothing to expand

    let kindMissingDistance = false;
    for (const t of tasks) {
      const hrs   = Number(t.hrs);
      const setup = Number(t.setup_hrs) || 0;
      const qtyRaw = Number(t.qty);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      if (t.per_run_ft) {
        if (!hasDistance) { kindMissingDistance = true; continue; }   // can't scale — skip, don't fabricate 0-ft hours
        lines.push({
          key: taskKey(t), task_name: (t.task_name || '').trim(), kind,
          hours: Math.round(((Number.isFinite(hrs) ? hrs : 0) * qty * totalFt + setup) * 1000) / 1000,
          per_run_ft: true,
        });
      } else {
        lines.push({
          key: taskKey(t), task_name: (t.task_name || '').trim(), kind,
          hours: Math.round(((Number.isFinite(hrs) ? hrs : 0) * qty + setup) * 1000) / 1000,
          per_run_ft: false,
        });
      }
    }
    if (kindMissingDistance) missingDistance.push(kind);
  }
  return { lines, missingDistance };
}

// Aggregate a whole project's instances into a task-hour-total rollup.
//   instances : array of device_instance rows (raw_labels, device_type_id,
//               removed_by_user, total_ft)
//   typesById : Map or plain object  type_id -> { name, labor }
// Returns:
//   {
//     tasks:            [ { task_name, hours, per_run_ft } ] sorted,
//     missing_distance: [ { type_id, name, family, instances } ] sorted,
//     total_hours,
//     coverage: { total_instances, expanded_instances }
//   }
export function aggregateLaborHours(instances, typesById) {
  const getType = (id) =>
    typeof typesById?.get === 'function' ? typesById.get(id) : typesById?.[id];

  const totals    = new Map();   // taskKey -> aggregated line
  const distFlags = new Map();
  let total = 0, expanded = 0;

  for (const inst of instances || []) {
    if (inst.removed_by_user) continue;
    total++;
    const type = getType(inst.device_type_id) || {};
    const { lines, missingDistance } = expandInstanceLabor(inst, type.labor);

    if (lines.length) expanded++;

    for (const ln of lines) {
      const agg = totals.get(ln.key);
      if (agg) agg.hours += ln.hours;
      else totals.set(ln.key, { task_name: ln.task_name, hours: ln.hours, per_run_ft: ln.per_run_ft });
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

  const tasks = [...totals.values()]
    .map(t => ({ ...t, hours: Math.round(t.hours * 1000) / 1000 }))
    .sort((a, b) => (a.task_name || '').localeCompare(b.task_name || ''));

  const missing_distance = [...distFlags.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '') ||
    (a.family || '').localeCompare(b.family || ''));

  const total_hours = Math.round(tasks.reduce((s, t) => s + t.hours, 0) * 1000) / 1000;

  return {
    tasks,
    missing_distance,
    total_hours,
    coverage: { total_instances: total, expanded_instances: expanded },
  };
}
