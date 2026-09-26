// public/lib/wf4-rollup.js
// WF4 Review roll-up — counts and cable totals from device rows. Pure (no DOM,
// no database) so the server summary and the Review screen compute the same
// numbers, and so it is unit-tested (tests/test-wf4-rollup.mjs).
//
// What counts:
//   * only devices on pages whose role is 'plan' (legend / schedule / detail /
//     skip / etc. never add to totals — this replaces the old set-page-role
//     "clear counts on a non-counting page" step);
//   * excluded devices (culled on the confidence map) are listed, never counted;
//   * duplicate pages (is_duplicate) are skipped.
//
// Input rows: { id, page_id, device_type_id, level?, tr_name?, route_ft?,
//               route_method?, route_multiplier?, tia_flag?, excluded?, flags?, source? }
// pages:      [{ id, role, level?, is_duplicate?, page_number?, title_text? }]
// types:      [{ id, name }]
// ─────────────────────────────────────────────────────────────────

const NONE = '—';
const round1 = (v) => Math.round(v * 10) / 10;

export function countablePageIds(pages = []) {
  return new Set(pages.filter((p) => p.role === 'plan' && !p.is_duplicate).map((p) => String(p.id)));
}

export function rollup(devices = [], pages = [], types = []) {
  const pageById = new Map(pages.map((p) => [String(p.id), p]));
  const typeName = new Map(types.map((t) => [String(t.id), t.name]));
  const counted = countablePageIds(pages);

  const byLevelType = new Map();   // level -> type -> count
  const byTr = new Map();          // tr -> { tr_name, devices, cable_ft, no_length, by_type }
  const perPage = new Map();       // page_id -> summary
  const modes = new Map();         // "mode@multiplier" -> device count
  const tia = [];
  const excluded = [];
  let total = 0, cableFt = 0, noLength = 0, manual = 0, needsPlacement = 0;

  for (const d of devices) {
    const pid = String(d.page_id);
    const page = pageById.get(pid);
    if (!counted.has(pid)) continue;

    const ps = perPage.get(pid) || { page_id: page.id, page_number: page.page_number ?? null, title: page.title_text ?? null,
      level: page.level ?? null, devices: 0, excluded: 0, no_length: 0, tia: 0, manual: 0 };
    perPage.set(pid, ps);

    if (d.excluded) { ps.excluded++; excluded.push(d.id); continue; }

    const type = typeName.get(String(d.device_type_id)) ?? 'Unknown type';
    const level = d.level ?? page.level ?? NONE;
    const tr = d.tr_name ?? NONE;

    total++; ps.devices++;
    if (d.source === 'manual') { manual++; ps.manual++; }
    if (Array.isArray(d.flags) && d.flags.includes('needs_placement')) needsPlacement++;

    const lt = byLevelType.get(level) || new Map();
    lt.set(type, (lt.get(type) || 0) + 1);
    byLevelType.set(level, lt);

    const t = byTr.get(tr) || { tr_name: tr, devices: 0, cable_ft: 0, no_length: 0, by_type: {} };
    t.devices++;
    t.by_type[type] = (t.by_type[type] || 0) + 1;
    const len = Number(d.route_ft);
    if (d.route_ft != null && Number.isFinite(len)) { t.cable_ft += len; cableFt += len; }
    else { t.no_length++; noLength++; ps.no_length++; }
    byTr.set(tr, t);

    if (d.route_method && d.route_method !== 'none') {
      const key = `${d.route_method}@${Number(d.route_multiplier ?? 0).toFixed(2)}`;
      modes.set(key, (modes.get(key) || 0) + 1);
    }
    if (d.tia_flag) { tia.push({ id: d.id, page_id: d.page_id, tr_name: tr, type, route_ft: d.route_ft }); ps.tia++; }
  }

  const sortKey = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  return {
    totals: { devices: total, cable_ft: round1(cableFt), no_length: noLength, excluded: excluded.length,
      tia: tia.length, manual, needs_placement: needsPlacement },
    by_level: [...byLevelType.entries()].sort(([a], [b]) => sortKey(a, b)).map(([level, m]) => ({
      level,
      devices: [...m.values()].reduce((s, n) => s + n, 0),
      by_type: Object.fromEntries([...m.entries()].sort(([a], [b]) => sortKey(a, b))),
    })),
    by_tr: [...byTr.values()].sort((a, b) => sortKey(a.tr_name, b.tr_name))
      .map((t) => ({ ...t, cable_ft: round1(t.cable_ft) })),
    // Mode + multiplier actually used, for the BOM's Notes & Assumptions.
    routing_used: [...modes.entries()].map(([k, n]) => {
      const [mode, m] = k.split('@');
      return { mode, multiplier: Number(m), devices: n };
    }).sort((a, b) => b.devices - a.devices),
    per_page: [...perPage.values()].sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0)),
    tia_violations: tia,
    excluded_ids: excluded,
    skipped_pages: pages.filter((p) => !counted.has(String(p.id))).length,
  };
}
