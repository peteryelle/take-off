// public/lib/wf8-bom.js
// WF8 BOM — the model behind the generated workbook. Pure (no DOM, no network):
// used by netlify/functions/wf8-bom.js, public/wf8.html and tests/test-wf8-bom.mjs.
//
// The BOM is OUTPUT ONLY. Quantities come from each step's CONFIRMED data and are
// written as values; the workbook layout only supplies sheet names, columns and the
// pricing arithmetic. Nothing here encodes a take-off rule — rack quantities come
// from WF6's confirmed rules (sizeTr), backbone from WF7's confirmed feeds, etc.
// ─────────────────────────────────────────────────────────────────────────────

import { sizeTr, countsSomething, METHODS, PARAM_LABEL } from './wf6-rules.js';
import { feedType, headEndCheck } from './wf7-riser.js';

const byName = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const r1 = (v) => Math.round(v * 10) / 10;

export const ROOM_LABEL = {
  rack_existing: 'Existing racks (reference)', wire_manager: 'Vertical wire manager', access_control: 'Access control device connection',
  backboard: 'Plywood backboard', cable_tray: 'Cable tray', camera_connection: 'Camera connection', ground_busbar: 'Ground busbar',
  motion_sensor: 'Motion sensor', sleeves: 'Sleeves', wall_mount: 'Wall-mount TR',
};

// Which steps feed which sheet.
export const SHEETS = [
  { key: 'tr_schedule', name: 'TR Schedule', steps: ['WF2', 'WF5', 'WF7'] },
  { key: 'rack_bom', name: 'Rack BOM', steps: ['WF6', 'WF5'] },
  { key: 'tr_summary', name: 'TR Summary', steps: ['WF6', 'WF5'] },
  { key: 'summary', name: 'Summary', steps: ['WF6'] },
  { key: 'device_counts', name: 'Device Counts', steps: ['WF4'] },
  { key: 'lengths', name: 'Lengths, by Device', steps: ['WF4'] },
  { key: 'floor_assemblies', name: 'Floor Assemblies', steps: ['WF4'] },
  { key: 'ancillary', name: 'Ancillary Components', steps: ['WF5'] },
  { key: 'backbone', name: 'Backbone', steps: ['WF7'] },
  { key: 'allowances', name: 'Allowances', steps: ['WF7'] },
  { key: 'notes', name: 'Notes & Assumptions', steps: [] },
];

// data = {
//   steps: { WF2: 'confirmed', ... },
//   trs: [{ tr_number, building, level, cat6a_terminations, min_patch_panels, source, override_basis }],
//   wf4: { rollup, types: [{ name, ports }] },
//   room: [{ tr_name, category, quantity, source, override_basis }],
//   wf6: { rules, elevations },
//   wf7: { feeds, cables, allowances, head_end, wf3_ends },
// }
export function buildBom(data) {
  const steps = data.steps || {};
  const trs = [...(data.trs || [])].sort((a, b) => byName(a.tr_number, b.tr_number));
  const room = data.room || [];
  const roomBy = new Map();
  for (const d of room) { if (!roomBy.has(d.tr_name)) roomBy.set(d.tr_name, {}); roomBy.get(d.tr_name)[d.category] = Number(d.quantity); }
  const rules = data.wf6?.rules || [];
  const elevations = data.wf6?.elevations || [];
  const feeds = data.wf7?.feeds || [];
  const cables = data.wf7?.cables || [];
  const allowances = data.wf7?.allowances || [];
  const confirmedFeeds = feeds.filter((f) => f.tr_name && f.confirmed_at);
  const feedBy = new Map(confirmedFeeds.map((f) => [f.tr_name, f]));
  const cableBy = new Map(cables.map((c) => [c.note_number, c]));

  const items = [];     // snapshot / change-order quantities
  const addItem = (key, item, unit, qty, step, detail = null, part = null) => {
    if (qty == null || !Number.isFinite(Number(qty))) return;
    items.push({ key, item, unit, qty: Math.round(Number(qty) * 100) / 100, step, detail, part_number: part });
  };

  // ── TR Schedule ──
  const trInputs = trs.map((t) => {
    const rm = roomBy.get(t.tr_number) || {};
    const f = feedBy.get(t.tr_number);
    const plant = f ? feedType(f, cables, { confirmedOnly: true }).isp_osp : null;
    return {
      tr: t.tr_number, building: t.building ?? null, level: t.level ?? null,
      terminations: t.cat6a_terminations ?? null, panels: t.min_patch_panels ?? null,
      racks_new: rm.rack_new ?? null, racks_existing: rm.rack_existing ?? null,
      wall_mount: rm.wall_mount ? true : (roomBy.has(t.tr_number) ? false : null),
      isp_osp: plant, status: t.status ?? null, source: t.source, basis: t.override_basis || null,
    };
  });
  const trSchedule = trInputs.map((t) => ({ ...t }));

  // ── WF6: rack items per TR (confirmed rules only) ──
  const counting = rules.filter((r) => countsSomething(r) && r.confirmed_at);
  const sized = trInputs.map((t) => sizeTr(rules, { tr_name: t.tr, racks: t.racks_new, panels: t.panels, terminations: t.terminations,
    isp_osp: t.isp_osp, wall_mount: t.wall_mount }, elevations, { requireConfirmed: true }));
  const perRackRules = counting.filter((r) => ['per_rack', 'schedule_div_racks', 'terminations_div_ports'].includes(r.qty_rule));
  const trLevelRules = counting.filter((r) => !perRackRules.includes(r));
  const colLabel = (r) => `${r.ref ? r.ref + ': ' : ''}${r.item}${r.ru && r.params?.ru_role?.v === 'height' ? ` (${r.ru}RU)` : ''}`;

  const rackRows = [];
  for (const s of sized) {
    if (!(s.racks > 0)) continue;
    for (let i = 0; i < s.racks; i++) {
      const cells = {};
      for (const r of perRackRules) {
        const it = s.items.find((x) => x.rule_key === r.rule_key);
        if (!it || it.qty == null) { cells[r.rule_key] = null; continue; }
        cells[r.rule_key] = it.per_rack && it.per_rack.length ? it.per_rack[i] : r.qty_rule === 'per_rack' ? it.qty / s.racks : null;
      }
      rackRows.push({ tr: s.tr_name, rack_no: i + 1, rack_id: `${s.tr_name}-${i + 1}`, cells });
    }
  }
  const trSummary = sized.map((s) => ({
    tr: s.tr_name, racks: s.racks,
    cells: Object.fromEntries(counting.map((r) => [r.rule_key, s.items.find((x) => x.rule_key === r.rule_key)?.qty ?? null])),
    open: s.items.filter((x) => x.qty == null && x.note).map((x) => `${x.ref || x.rule_key}: ${x.note}`),
    check: s.check,
  }));
  const summaryRows = counting.map((r) => {
    const qty = sized.reduce((sum, s) => { const it = s.items.find((x) => x.rule_key === r.rule_key); return sum + (it?.qty ?? 0); }, 0);
    const missing = sized.filter((s) => s.racks != null && s.items.find((x) => x.rule_key === r.rule_key)?.qty == null).length;
    const row = { key: `wf6:${r.rule_key}`, item: r.item, detail: METHODS[r.qty_rule]?.label || r.qty_rule, part: r.part_number || null,
      ref: r.ref, qty: r1(qty), unit: 'ea', missing, install_only: !!r.params?.install_only?.v };
    addItem(row.key, r.item, 'ea', row.qty, 'WF6', row.detail, row.part);
    return row;
  });

  // ── WF4: devices and lengths by level ──
  const rollup = data.wf4?.rollup || { by_level: [], types: [], by_tr: [], routing_used: [], totals: {} };
  const types = rollup.types || [];
  const portsBy = new Map((data.wf4?.types || []).map((t) => [t.name, t.ports ?? null]));
  const deviceCounts = { types, rows: rollup.by_level.map((l) => ({ level: l.level, counts: Object.fromEntries(types.map((t) => [t, l.by_type?.[t] ?? 0])) })) };
  const lengths = { types, rows: rollup.by_level.map((l) => ({ level: l.level, ft: Object.fromEntries(types.map((t) => [t, r1(l.cable_by_type?.[t] ?? 0)])), no_length: l.no_length })) };
  const typeTotals = Object.fromEntries(types.map((t) => [t, deviceCounts.rows.reduce((s, r) => s + (r.counts[t] || 0), 0)]));
  const ftTotals = Object.fromEntries(types.map((t) => [t, r1(lengths.rows.reduce((s, r) => s + (r.ft[t] || 0), 0))]));
  for (const t of types) { addItem(`wf4:count:${t}`, t, 'ea', typeTotals[t], 'WF4'); addItem(`wf4:ft:${t}`, `${t} cable`, 'ft', ftTotals[t], 'WF4'); }
  const floorAssemblies = types.map((t) => {
    const ports = portsBy.get(t);
    return { type: t, ports, faceplates: typeTotals[t], jacks: ports == null ? null : typeTotals[t] * ports };
  });
  for (const f of floorAssemblies) if (f.jacks != null) addItem(`wf4:jacks:${f.type}`, `${f.type} jacks`, 'ea', f.jacks, 'WF4');

  // ── WF5: room items (TR rooms) ──
  const ancillary = Object.keys(ROOM_LABEL).filter((c) => c !== 'wall_mount').map((c) => {
    const rows = room.filter((d) => d.category === c);
    const qty = rows.reduce((s, d) => s + Number(d.quantity || 0), 0);
    return { key: `wf5:${c}`, item: ROOM_LABEL[c], category: c, unit: c === 'cable_tray' ? 'ft' : 'ea', qty: r1(qty), trs: new Set(rows.map((d) => d.tr_name)).size };
  }).filter((a) => a.trs > 0);
  for (const a of ancillary) if (a.category !== 'rack_existing') addItem(a.key, a.item, a.unit, a.qty, 'WF5');

  // ── WF7: backbone and allowances ──
  const backbone = confirmedFeeds.map((f) => {
    const notes = [f.core_a_note, f.core_b_note].filter((n) => n != null);
    const c = cableBy.get(f.core_a_note ?? f.core_b_note);
    return { tr: f.tr_name, riser_label: f.riser_label, building: f.building, floor: f.floor, cores: notes.length,
      notes: notes.map((n) => `CN ${n}`).join(' / '), isp_osp: feedType(f, cables, { confirmedOnly: true }).isp_osp,
      strands_text: c?.strands_text ?? null, strands_per_core: c?.strands_per_core ?? null, added: f.match_kind === 'added' };
  }).sort((a, b) => byName(a.tr, b.tr));
  const backboneTotals = [];
  for (const c of cables.filter((x) => x.confirmed_at)) {
    const cores = confirmedFeeds.reduce((s, f) => s + [f.core_a_note, f.core_b_note].filter((n) => n === c.note_number).length, 0);
    if (!cores) continue;
    backboneTotals.push({ note_number: c.note_number, cable: c.note_text, strands_text: c.strands_text, isp_osp: c.isp_osp, cores });
    addItem(`wf7:cable:${c.note_number}`, `Backbone cable CN ${c.note_number} (${c.strands_text || 'cable'}) — core runs`, 'runs', cores, 'WF7', c.isp_osp?.toUpperCase());
  }
  const allowanceRows = allowances.filter((a) => a.confirmed_at).map((a) => ({ key: `wf7:allow:${a.allowance_key}`, system: a.system, item: a.item,
    per_unit_qty: a.per_unit_qty == null ? null : Number(a.per_unit_qty), unit: a.unit, unit_count: a.unit_count, per_text: a.per_text, note_ref: a.note_ref }));
  for (const a of allowanceRows) if (a.per_unit_qty != null && a.unit_count != null) addItem(a.key, `${a.system}: ${a.item}`, a.unit || 'ea', a.per_unit_qty * a.unit_count, 'WF7');

  // ── readiness ──
  const unconfirmed = {
    WF6: rules.filter((r) => countsSomething(r) && !r.confirmed_at).length,
    WF7: feeds.filter((f) => f.tr_name && !f.confirmed_at).length + cables.filter((c) => !c.confirmed_at).length + allowances.filter((a) => !a.confirmed_at).length,
  };
  const hasData = { tr_schedule: trs.length > 0, rack_bom: rackRows.length > 0, tr_summary: counting.length > 0, summary: counting.length > 0,
    device_counts: types.length > 0, lengths: types.length > 0, floor_assemblies: types.length > 0, ancillary: ancillary.length > 0,
    backbone: backbone.length > 0, allowances: allowanceRows.length > 0, notes: true };
  const sections = SHEETS.map((s) => {
    if (s.key === 'notes') return { ...s, status: 'written', why: 'written from every step when you generate' };
    const notConfirmed = s.steps.filter((c) => steps[c] && steps[c] !== 'confirmed' && steps[c] !== 'not_applicable');
    const open = s.steps.reduce((n, c) => n + (unconfirmed[c] || 0), 0);
    const status = !hasData[s.key] ? 'no data' : notConfirmed.length ? 'waiting' : open ? 'to review' : 'ready';
    const why = !hasData[s.key] ? `nothing confirmed yet in ${s.steps.join(', ')}`
      : notConfirmed.length ? `${notConfirmed.join(', ')} not confirmed` : open ? `${open} item(s) not confirmed in ${s.steps.filter((c) => unconfirmed[c]).join(', ')}` : 'confirmed';
    return { ...s, status, why };
  });

  // ── cross-checks ──
  const checks = [];
  if (types.length && trs.length) {
    const portsPerTr = new Map();
    for (const t of rollup.by_tr || []) {
      let p = 0, unknown = false;
      for (const [type, n] of Object.entries(t.by_type || {})) { const pt = portsBy.get(type); if (pt == null) unknown = true; else p += n * pt; }
      portsPerTr.set(t.tr_name, { ports: p, unknown });
    }
    const off = trs.filter((t) => t.cat6a_terminations != null && portsPerTr.has(t.tr_number) && portsPerTr.get(t.tr_number).ports !== Number(t.cat6a_terminations))
      .map((t) => `${t.tr_number} ${portsPerTr.get(t.tr_number).ports - Number(t.cat6a_terminations) > 0 ? '+' : ''}${portsPerTr.get(t.tr_number).ports - Number(t.cat6a_terminations)}`);
    checks.push({ name: 'Ports per TR vs schedule terminations', steps: 'WF4 ↔ WF2', ok: !off.length, result: off.length ? `${off.length} off` : 'ok', detail: off.slice(0, 12).join(', ') || 'plan ports match the schedule' });
  }
  const cap = sized.filter((s) => s.check?.level === 'warn');
  if (counting.length) checks.push({ name: 'Terminations vs rack elevation capacity', steps: 'WF2 ↔ WF6', ok: !cap.length, result: cap.length ? `${cap.length} off` : 'ok', detail: cap.map((s) => `${s.tr_name}: ${s.check.text}`).slice(0, 8).join(' · ') || 'within capacity' });
  if (feeds.length) {
    const noFeed = trs.filter((t) => !feedBy.has(t.tr_number)).map((t) => t.tr_number);
    checks.push({ name: 'Schedule TRs with a confirmed riser feed', steps: 'WF7 ↔ WF2', ok: !noFeed.length, result: noFeed.length ? `${noFeed.length} without` : 'ok', detail: noFeed.slice(0, 12).join(', ') || 'every TR has a feed' });
    const he = headEndCheck(data.wf7?.head_end || [], feeds, cables);
    if (he.length) checks.push({ name: 'Head end vs riser feeds', steps: 'WF7', ok: he.every((h) => h.ok), result: he.every((h) => h.ok) ? 'ok' : 'off', detail: he.map((h) => `core ${h.core}: (${h.qty}) CN ${h.note_number} vs ${h.riser_cores}`).join(' · ') });
    const ends = new Set(data.wf7?.wf3_ends || []);
    if (ends.size) {
      const noRoute = backbone.filter((b) => b.isp_osp === 'osp' && !ends.has(b.tr)).map((b) => b.tr);
      checks.push({ name: 'OSP feeds vs WF3 route ends', steps: 'WF7 ↔ WF3', ok: !noRoute.length, result: noRoute.length ? `${noRoute.length} without` : 'ok', detail: noRoute.slice(0, 12).join(', ') || 'every OSP TR has a route' });
    }
  }
  const openTotal = Object.values(unconfirmed).reduce((a, b) => a + b, 0);
  checks.push({ name: 'Items not confirmed (not in the BOM)', steps: 'WF6–WF7', ok: !openTotal, result: openTotal ? `${openTotal}` : 'ok', detail: Object.entries(unconfirmed).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'none' });

  // ── notes & assumptions (generated) ──
  const notes = [];
  const note = (topic, text) => notes.push({ topic, text });
  note('How this workbook was made', 'Generated by Take-off from confirmed data in each workflow step. Quantities are values traced to their step and rule; only the pricing columns are formulas. Unit cost, margin and labor are left for you to fill in unless a parts catalog is loaded.');
  for (const s of sections.filter((x) => x.key !== 'notes' && x.status !== 'ready')) note(`Sheet not ready — ${s.name}`, `${s.status}: ${s.why}. Generated with what is confirmed.`);
  for (const r of rules.filter((x) => countsSomething(x) && x.confirmed_at)) {
    for (const [p, v] of Object.entries(r.params || {})) {
      if (v && v.source === 'user' && v.v != null && v.v !== '') note(`Set by user — ${r.ref || r.rule_key}`, `${PARAM_LABEL[p] || p} = ${v.v} (not stated on the rack elevation sheet). Rule: ${r.item}.`);
    }
    if (r.source === 'edited' || r.source === 'manual') note(`Rule changed by user — ${r.ref || r.rule_key}`, `${r.item}: ${r.override_basis || ''}`);
  }
  for (const r of rules.filter((x) => x.note_kind !== 'drawing' && x.qty_rule === 'not_stated')) note(`No quantity on the sheet — ${r.ref}`, r.item);
  for (const r of rules.filter((x) => x.note_kind === 'drawing' && x.params?.no_quantity?.v)) note(`No quantity on the sheet — ${r.ref}`, r.item);
  for (const r of rules.filter((x) => x.note_kind === 'coded' && x.qty_rule === 'none')) note(`Not counted — ${r.ref}`, r.item);
  for (const t of trs.filter((x) => x.source === 'manual' || x.source === 'edited')) note(`TR list — ${t.tr_number}`, `${t.source === 'manual' ? 'entered by hand' : 'edited'}: ${t.override_basis || ''}`);
  const manualRoom = room.filter((d) => d.source === 'manual' || d.source === 'edited');
  if (manualRoom.length) note('TR rooms', `${manualRoom.length} room value(s) entered by hand from the room plans (${new Set(manualRoom.map((d) => d.override_basis)).size} reason(s), e.g. "${manualRoom[0].override_basis}").`);
  for (const m of rollup.routing_used || []) note('Cable routing', `${m.mode} × ${m.multiplier} for ${m.devices} device(s).`);
  if (rollup.totals?.no_length) note('Cable lengths', `${rollup.totals.no_length} device(s) have no cable length yet; they are counted but add no feet.`);
  for (const f of floorAssemblies.filter((x) => x.ports == null)) note('Ports per outlet', `${f.type}: ports per outlet not set in the device library — jacks left blank.`);
  for (const f of confirmedFeeds.filter((x) => x.match_kind === 'added')) note(`Added from the riser — ${f.tr_name}`, `${f.building || ''} ${f.riser_label || ''} is not on the schedule; added in WF7.`);
  for (const a of allowances.filter((x) => x.confirmed_at && x.source === 'edited')) note(`Allowance changed — ${a.system}`, `${a.item}: ${a.override_basis || ''}`);
  for (const c of checks.filter((x) => !x.ok)) note(`Check — ${c.name}`, `${c.result}: ${c.detail}`);

  return {
    sheets: { tr_schedule: trSchedule, rack_bom: { columns: perRackRules.map((r) => ({ rule_key: r.rule_key, label: colLabel(r), zone: r.zone })), rows: rackRows },
      tr_summary: { columns: counting.map((r) => ({ rule_key: r.rule_key, label: colLabel(r) })), rows: trSummary },
      summary: summaryRows, device_counts: deviceCounts, lengths, floor_assemblies: floorAssemblies, ancillary,
      backbone: { rows: backbone, totals: backboneTotals }, allowances: allowanceRows, notes },
    items: items.sort((a, b) => byName(a.key, b.key)),
    sections, checks,
    stats: { trs: trs.length, racks: rackRows.length, rules: counting.length, feeds: confirmedFeeds.length, items: items.length },
  };
}

// Change order lines: current vs reference quantities, by item key.
export function diffItems(refItems = [], curItems = []) {
  const ref = new Map(refItems.map((i) => [i.key, i]));
  const cur = new Map(curItems.map((i) => [i.key, i]));
  const keys = [...new Set([...ref.keys(), ...cur.keys()])].sort(byName);
  const lines = [];
  for (const k of keys) {
    const a = ref.get(k), b = cur.get(k);
    const rq = a ? Number(a.qty) : 0, cq = b ? Number(b.qty) : 0;
    if (Math.abs(cq - rq) < 1e-9) continue;
    const it = b || a;
    lines.push({ key: k, item: it.item, unit: it.unit, step: it.step, ref_qty: rq, cur_qty: cq, delta: Math.round((cq - rq) * 100) / 100,
      line_type: cq > rq ? 'add' : 'credit', part_number: it.part_number || null });
  }
  return lines;
}

// Which sheet revisions changed between two snapshots, by step.
export function revisionChanges(refRevs = {}, curRevs = {}) {
  const out = [];
  for (const [sheet, cur] of Object.entries(curRevs)) {
    const ref = refRevs[sheet];
    if (!ref) out.push({ sheet, step: cur.step, from: null, to: cur.rev });
    else if (ref.rev !== cur.rev) out.push({ sheet, step: cur.step, from: ref.rev, to: cur.rev });
  }
  for (const [sheet, ref] of Object.entries(refRevs)) if (!curRevs[sheet]) out.push({ sheet, step: ref.step, from: ref.rev, to: null });
  return out;
}

export function causeFor(line, changes) {
  const mine = changes.filter((c) => c.step === line.step);
  if (!mine.length) return { cause_kind: 'manual', cause_note: `${line.step} data changed (no sheet revision changed)` };
  return { cause_kind: 'revision', cause_note: mine.map((c) => `${c.sheet} ${c.from ?? 'new'} → ${c.to ?? 'removed'}`).join(', ') };
}
