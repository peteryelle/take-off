// public/lib/wf6-rules.js
// WF6 Rack & details — rules read from the typical rack elevation sheet.
// Pure (no DOM, no network): used by public/wf6.html, netlify/functions/wf6-rules.js
// and tests/test-wf6-rules.mjs.
//
// NOTHING project-specific lives here. No sheet numbers, no part numbers, no
// strand counts, no "N+1". Every number a rule uses is either read from the
// sheet's own coded / drawing notes (and shown with the note it came from) or
// set by the user and flagged "not stated on sheet". The engine only knows a
// small set of counting METHODS; which method each note uses is suggested from
// its wording and confirmed by the user.
// ─────────────────────────────────────────────────────────────────────────────

import { parseCodedNotes } from './parse-coded-notes.js';
import { splitNumberedNotes } from './note-rules.js';

// ── text layer -> lines ──────────────────────────────────────────────────────
// pdf.js returns raw runs; a coded-note bubble number or a drawing label can be
// emitted after the text it sits left of. Group into lines by y first, then sort
// each line by x before merging, so a run is never merged backwards.
export function linesFromTextContent(items, width, height, opts = {}) {
  const raw = (items || []).filter((i) => i.str && i.str.trim()).map((i) => {
    const fs = Math.abs(i.transform[3]) || Math.hypot(i.transform[2], i.transform[3]) || 10;
    return { s: i.str, left: i.transform[4], right: i.transform[4] + (i.width || 0), cy: height - i.transform[5], fs };
  }).sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const it of raw) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.cy - L.cy) <= Math.min(it.fs, L.fs) * (opts.lineTol ?? 0.35)) L.items.push(it);
    else lines.push({ cy: it.cy, items: [it] });
  }
  const out = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.left - b.left);
    let cur = null;
    for (const it of L.items) {
      const gap = cur ? it.left - cur.right : null;
      if (cur && gap >= -cur.fs * 0.3 && gap <= cur.fs * (opts.maxMergeFrac ?? 1.0)) {
        cur.s += (gap > cur.fs * 0.15 ? ' ' : '') + it.s;
        cur.right = Math.max(cur.right, it.right);
      } else { if (cur) out.push(cur); cur = { ...it }; }
    }
    if (cur) out.push(cur);
  }
  return out.map((r) => ({ str: r.s, cx_norm: (r.left + r.right) / 2 / width, cy_norm: r.cy / height, left_norm: r.left / width }));
}

// ── drawing notes ("1. TEXT ...") between the DRAWING NOTES title and the next title ──
export function readDrawingNotes(runs) {
  const title = runs.find((r) => /DRAWING\s*NOTES/i.test(r.str));
  if (!title) return [];
  const next = runs.filter((r) => r !== title && r.cy_norm > title.cy_norm && /^[A-Z ]*NOTES:?\s*$/i.test(r.str.trim()))
    .sort((a, b) => a.cy_norm - b.cy_norm)[0];
  const yEnd = next ? next.cy_norm : title.cy_norm + 0.3;
  const left = (title.left_norm ?? title.cx_norm) - 0.01;
  const body = runs.filter((r) => r.cy_norm > title.cy_norm && r.cy_norm < yEnd && (r.left_norm ?? r.cx_norm) >= left)
    .sort((a, b) => a.cy_norm - b.cy_norm || a.cx_norm - b.cx_norm);
  return splitNumberedNotes(body.map((r) => r.str).join(' ')).map((n) => ({ number: Number(n.ref), text: n.text }));
}

// ── typical elevations: titles, detail bubbles, stated capacities ──
const ELEV_RACK = /TYPICAL\s+(\d+)\s+RACK\s+ELEVATION/i;
const ELEV_WALL = /WALL[- ]MOUNT(?:ED)?\s+(?:ENCLOSURE|CABINET)/i;

export function readElevations(runs) {
  const titles = [];
  for (const r of runs) {
    const m = ELEV_RACK.exec(r.str);
    const wall = !m && new RegExp('^' + ELEV_WALL.source, 'i').test(r.str.trim()) && !r.str.includes(';') && r.str.trim().length < 70;
    if (!m && !wall) continue;
    const bubble = runs.filter((b) => /^\d{1,2}$/.test(b.str.trim()) && Math.abs(b.cy_norm - r.cy_norm) < 0.012
      && (r.left_norm ?? r.cx_norm) - b.cx_norm > 0 && (r.left_norm ?? r.cx_norm) - b.cx_norm < 0.08)
      .sort((a, b) => b.cx_norm - a.cx_norm)[0];
    titles.push({ title: r.str.trim(), rack_count: m ? m[1] : 'wall_mount', detail_ref: bubble ? bubble.str.trim() : null,
      cx: r.cx_norm, left: r.left_norm ?? r.cx_norm, cy: r.cy_norm, capacity_passive: null, capacity_active: null, capacity_text: [] });
  }
  // capacity labels: "PATCHING (UP TO 960 / PASSIVE ..." and "SWITCHING (...ACTIVE ...)"
  const labels = [];
  for (const r of runs) {
    if (!/^(PATCHING|SWITCHING)\s*\(/i.test(r.str.trim())) continue;
    let text = r.str.trim(), y = r.cy_norm;
    for (let k = 0; k < 4 && !text.includes(')'); k++) {
      const nx = runs.filter((c) => c.cy_norm > y && c.cy_norm - y < 0.012 && Math.abs((c.left_norm ?? c.cx_norm) - (r.left_norm ?? r.cx_norm)) < 0.025)
        .sort((a, b) => a.cy_norm - b.cy_norm)[0];
      if (!nx) break;
      text += ' ' + nx.str.trim(); y = nx.cy_norm;
    }
    const m = /((?:UP TO\s+)?(?:MAXIMUM\s+)?|OVER\s+)(\d+)\s+(PASSIVE|ACTIVE)/i.exec(text);
    if (m) labels.push({ kind: m[3].toUpperCase() === 'PASSIVE' ? 'passive' : 'active', value: Number(m[2]), over: /OVER/i.test(m[1]), text, cx: r.cx_norm, cy: r.cy_norm });
  }
  // Pair labels with elevations: rack elevations sit in rows; labels above a row belong to it,
  // matched left-to-right in order (falls back to the nearest title's left edge).
  const racks = titles.filter((t) => t.rack_count !== 'wall_mount');
  const rows = [];
  for (const t of [...racks].sort((a, b) => a.cy - b.cy)) {
    const row = rows.find((w) => Math.abs(w.cy - t.cy) < 0.02);
    if (row) row.titles.push(t); else rows.push({ cy: t.cy, titles: [t] });
  }
  rows.forEach((row, i) => {
    const top = i ? rows[i - 1].cy : 0;
    row.titles.sort((a, b) => a.cx - b.cx);
    for (const kind of ['passive', 'active']) {
      const mine = labels.filter((l) => l.kind === kind && l.cy > top && l.cy < row.cy).sort((a, b) => a.cx - b.cx);
      mine.forEach((l, j) => {
        const t = mine.length === row.titles.length ? row.titles[j]
          : [...row.titles].sort((a, b) => Math.abs(a.left - l.cx) - Math.abs(b.left - l.cx))[0];
        if (kind === 'passive') t.capacity_passive = l.value; else { t.capacity_active = l.value; t.active_over = l.over; }
        t.capacity_text.push(l.text);
      });
    }
  });
  return titles.map(({ cx, left, cy, ...t }) => ({ ...t, capacity_text: t.capacity_text.join(' · ') || null }));
}

// ── fields read from one note's wording ──
export function readNoteFields(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const parts = [...t.matchAll(/BASIS OF DESIGN(?: IS|:)\s+(.+?)(?:,?\s+OR APPROVED EQUAL|\.(?:\s|$)|,\s)/gi)].map((m) => m[1].replace(/-\s+/g, '-').replace(/\s+WITH\s+.*$/i, '').trim());
  const ru = (/(\d+)\s*RU\b/i.exec(t) || [])[1];
  const ports = (/(\d+)[- ]PORT\b/i.exec(t) || [])[1];
  const slots = (/\((\d+)\)\s*CASSETTES?/i.exec(t) || [])[1];
  // strands per core; text after an "outside plant" phrase is the OSP case.
  const ospAt = t.search(/OUT ?SIDE PLANT|\bOSP\b/i);
  const strandSum = (seg) => {
    const hits = [...seg.matchAll(/(\d+)[- ]STRANDS?(?: OF)? (OM\d|OS\d)/gi)].map((m) => ({ n: Number(m[1]), type: m[2].toUpperCase() }));
    return hits.length ? { total: hits.reduce((s, h) => s + h.n, 0), parts: hits } : null;
  };
  const isp = strandSum(ospAt >= 0 ? t.slice(0, ospAt) : t);
  const osp = ospAt >= 0 ? strandSum(t.slice(ospAt)) : null;
  const cores = new Set([...t.matchAll(/CORE-([A-Z])\b/gi)].map((m) => m[1].toUpperCase())).size;
  const item = t.replace(/^PROVIDE\s+/i, '').split(/\.\s|\. ?BASIS OF DESIGN/i)[0].replace(/\.$/, '').trim();
  return {
    item, part: parts[0] || null, parts,
    ru: ru ? Number(ru) : null, ports: ports ? Number(ports) : null, slots: slots ? Number(slots) : null,
    strands: isp || osp ? { isp, osp } : null, cores: cores || null,
    owner_furnished: /FURNISHED BY (?:THE )?(?:VA|OWNER|GOVERNMENT)/i.test(t),
    refer_only: /^REFER TO\b/i.test(t),
  };
}

// ── counting methods (mechanics only) ──
export const METHODS = {
  per_rack: { label: 'Per new rack', params: ['each'] },
  racks_plus_one: { label: 'New racks + 1', params: [] },
  per_tr: { label: 'Per TR with new racks', params: ['each'] },
  strands_div_cassette: { label: 'Strands ÷ fibers per cassette, × cores', params: ['strands_isp', 'strands_osp', 'cores', 'fibers_per_cassette'] },
  schedule_div_racks: { label: 'Schedule patch panels, split across racks', params: [] },
  terminations_div_ports: { label: 'Terminations ÷ ports per switch, split across racks', params: ['ports_per_switch'] },
  per_panel: { label: 'Per patch panel × ratio', params: ['each'] },
  unused_ru: { label: 'Unused RU in each rack', params: ['switch_ru', 'power_ru_per_rack'] },
  per_wall_mount: { label: 'Per wall-mount TR', params: ['each'] },
  layout: { label: 'Layout only (not counted)', params: [] },
  none: { label: 'Not counted', params: [] },
  not_stated: { label: 'Quantity not stated', params: [] },
};
export const METHOD_KEYS = Object.keys(METHODS);

export const PARAM_LABEL = {
  each: 'Quantity each', strands_isp: 'Strands per core (ISP)', strands_osp: 'Strands per core (OSP)', cores: 'Cores',
  fibers_per_cassette: 'Fibers per cassette', ports_per_switch: 'Ports per switch', switch_ru: 'RU per switch',
  power_ru_per_rack: 'RU used by power per rack',
};

const has = (t, re) => re.test(t);
const val = (v, source) => ({ v, source });   // source: 'sheet' | 'user' | 'default'

// One rule row (or two, for a fiber unit with cassettes) per coded note.
export function suggestRules(coded = [], drawing = []) {
  const dnText = drawing.map((d) => d.text).join(' ');
  const dnSplit = drawing.find((d) => /DIVIDED AS EVENLY/i.test(d.text));
  const dnBlank = drawing.find((d) => /BLANK\w*\s+(?:PLATES?|PANELS?)\s+FOR ALL UNUSED/i.test(d.text));
  const zones = [...dnText.matchAll(/(TOP|MIDDLE|BOTTOM)\s+THIRD[^.]*?DESIGNATED FOR ([^.]+)/gi)]
    .map((m) => ({ zone: m[1].toLowerCase(), words: m[2].toUpperCase() }));
  const zoneFor = (item) => {
    const u = item.toUpperCase();
    const score = (w) => ['FIBER', 'SWITCH', 'PATCH PANEL', 'CABLE MANAGE', 'POWER'].filter((k) => u.includes(k) && w.includes(k)).length;
    const best = zones.map((z) => ({ z: z.zone, s: score(z.words) })).sort((a, b) => b.s - a.s)[0];
    return best && best.s ? best.z : null;
  };

  const rules = [];
  const add = (n, key, f, qty_rule, params, extra = {}) => rules.push({
    rule_key: key, note_kind: 'coded', note_number: n.number, ref: `CN ${n.number}`,
    item: extra.item || f.item, part_number: 'part' in extra ? extra.part : f.part, ru: 'ru' in extra ? extra.ru : f.ru,
    qty_rule, params, zone: extra.zone !== undefined ? extra.zone : zoneFor(extra.item || f.item),
    stated_on_sheet: extra.stated ?? true, note_text: n.text,
  });

  for (const n of coded) {
    const t = n.text.toUpperCase();
    const f = readNoteFields(n.text);
    const key = `CN${n.number}`;
    if (f.refer_only) { add(n, key, f, 'none', {}, { stated: false, zone: null }); continue; }
    if (has(t, /WALL[- ]MOUNT/) && has(t, /CABINET|ENCLOSURE/)) {
      add(n, key, f, 'per_wall_mount', { each: val(1, 'default'), ru_role: val('capacity', 'sheet') }); continue;
    }
    if (has(t, /EQUIPMENT RACK|\d-POST/) && !has(t, /MOUNTED/)) {
      add(n, key, f, 'per_rack', { each: val(1, 'default'), ru_role: val('capacity', 'sheet') }); continue;
    }
    if (has(t, /VERTICAL CABLE MANAGER|SIDECAR/)) {
      add(n, key, f, 'racks_plus_one', {}, { stated: false, zone: 'side' }); continue;
    }
    if (has(t, /FIBER/) && has(t, /PATCH UNIT|PATCH PANEL|ENCLOSURE|SHELF|LIU/)) {
      add(n, key, f, 'per_tr', { each: val(1, 'default'), ru_role: val('height', 'sheet') }, { stated: false });
      if (f.slots || f.strands) {
        const fpc = null;   // "(12) CASSETTES" is the unit's slot count, not fibers per cassette
        add(n, `${key}-cassette`, f, 'strands_div_cassette', {
          strands_isp: val(f.strands?.isp?.total ?? null, f.strands?.isp ? 'sheet' : 'user'),
          strands_osp: val(f.strands?.osp?.total ?? null, f.strands?.osp ? 'sheet' : 'user'),
          cores: val(f.cores ?? null, f.cores ? 'sheet' : 'user'),
          fibers_per_cassette: val(fpc, 'user'),
          slots_per_unit: val(f.slots ?? null, f.slots ? 'sheet' : 'user'),
        }, { item: `Cassettes for the ${f.item.replace(/^\d+\s*RU\s+/i, '').toLowerCase()}`, part: f.parts[1] || null, ru: null });
      }
      continue;
    }
    if (has(t, /PATCH PANEL/)) {
      add(n, key, f, 'schedule_div_racks', { split_even: val(!!dnSplit, dnSplit ? 'sheet' : 'user'), ports: val(f.ports, f.ports ? 'sheet' : 'user'), ru_role: val('height', 'sheet') });
      continue;
    }
    if (has(t, /BLANK/)) {
      add(n, key, f, 'unused_ru', { switch_ru: val(null, 'user'), power_ru_per_rack: val(null, 'user'), ru_role: val('height', 'sheet') }, { stated: !!dnBlank });
      continue;
    }
    if (has(t, /SWITCH/)) {
      add(n, key, f, 'terminations_div_ports', {
        ports_per_switch: val(f.ports ?? null, f.ports ? 'sheet' : 'user'),
        split_even: val(!!dnSplit, dnSplit ? 'sheet' : 'user'), install_only: val(f.owner_furnished, 'sheet'),
      }, { stated: false });
      continue;
    }
    if (has(t, /HORIZONTAL/) && has(t, /CABLE MANAGE/)) {
      add(n, key, f, 'per_panel', { each: val(null, 'user'), ru_role: val('height', 'sheet') }, { stated: false });
      continue;
    }
    add(n, key, f, 'not_stated', {}, { stated: false });
  }

  for (const d of drawing) {
    const t = d.text.toUpperCase();
    const zone = /THIRD|DIVIDED AS EVENLY/.test(t) ? 'layout' : null;
    const noQty = /\bAS REQUIRED\b/.test(t) && /PROVIDE/.test(t);
    rules.push({
      rule_key: `DN${d.number}`, note_kind: 'drawing', note_number: d.number, ref: `DN ${d.number}`,
      item: d.text.split(/\.\s/)[0].slice(0, 160), part_number: null, ru: null,
      qty_rule: zone ? 'layout' : noQty ? 'not_stated' : 'none', params: noQty ? { no_quantity: val(true, 'sheet') } : {},
      zone: null, stated_on_sheet: true, note_text: d.text,
    });
  }
  return rules;
}

// Params the user must still set (not stated on the sheet), per rule.
export function missingParams(rule) {
  const need = METHODS[rule.qty_rule]?.params || [];
  return need.filter((p) => rule.params?.[p] == null || rule.params[p].v == null || rule.params[p].v === '');
}
const pv = (rule, p, dflt = null) => { const x = rule.params?.[p]; return x && x.v != null && x.v !== '' ? Number(x.v) : dflt; };

export function splitEven(total, n) {
  if (!(n > 0) || total == null) return [];
  const base = Math.floor(total / n), rem = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// Capacity for a rack count, from the elevations read off the sheet.
export function capacityFor(elevations, racks) {
  const e = (elevations || []).find((x) => String(x.rack_count) === String(racks));
  return e ? { passive: e.capacity_passive ?? null, active: e.capacity_active ?? null, detail_ref: e.detail_ref } : null;
}

// A rule that counts something needs the user's confirmation before it is applied.
export const countsSomething = (r) => r.note_kind !== 'drawing' && !['layout', 'none'].includes(r.qty_rule);
export const isConfirmed = (r) => !!r.confirmed_at;
// Why a rule can't be confirmed yet (null = it can).
export function confirmBlocker(r) {
  if (r.conflict) return 'the sheet now reads differently — take the new read or edit, then confirm';
  const miss = missingParams(r);
  if (miss.length) return 'set ' + miss.map((p) => PARAM_LABEL[p] || p).join(', ') + ' first';
  if (r.qty_rule === 'not_stated') return 'pick how it is counted first';
  return null;
}

// Apply confirmed rules to one TR.
// tr: { tr_name, racks (WF5 new racks|null), panels (WF2), terminations (WF2), isp_osp ('isp'|'osp'|null), wall_mount (bool|null) }
export function sizeTr(rules, tr, elevations = [], opts = {}) {
  const requireConfirmed = !!opts.requireConfirmed;
  const racks = tr.racks == null ? null : Number(tr.racks);
  const out = [];
  const byKey = new Map();
  const counted = rules.filter((r) => !['layout', 'none'].includes(r.qty_rule) && r.note_kind !== 'drawing');
  // pass 1: everything except unused RU
  for (const r of counted.filter((x) => x.qty_rule !== 'unused_ru')) {
    const miss = missingParams(r);
    let qty = null, per_rack = null, note = null;
    if (requireConfirmed && !isConfirmed(r)) note = 'rule not confirmed';
    else if (racks == null && r.qty_rule !== 'per_wall_mount') note = 'rack count not entered in WF5';
    else if (miss.length) note = 'set ' + miss.map((p) => PARAM_LABEL[p] || p).join(', ');
    else switch (r.qty_rule) {
      case 'per_rack': qty = racks * pv(r, 'each', 1); break;
      case 'racks_plus_one': qty = racks > 0 ? racks + 1 : 0; break;
      case 'per_tr': qty = racks > 0 ? pv(r, 'each', 1) : 0; break;
      case 'strands_div_cassette': {
        if (!(racks > 0)) { qty = 0; break; }
        if (!tr.isp_osp) { note = 'ISP/OSP waits on WF7'; break; }
        const strands = pv(r, tr.isp_osp === 'osp' ? 'strands_osp' : 'strands_isp');
        if (strands == null) { note = `strands per core (${tr.isp_osp.toUpperCase()}) not set`; break; }
        qty = Math.ceil(strands / pv(r, 'fibers_per_cassette')) * pv(r, 'cores', 1);
        const slots = pv(r, 'slots_per_unit');
        if (slots && qty > slots) note = `${qty} cassettes > ${slots} slots in one unit`;
        break;
      }
      case 'schedule_div_racks':
        if (tr.panels == null) { note = 'patch panels not in WF2'; break; }
        qty = Number(tr.panels);
        if (racks > 0 && r.params?.split_even?.v) per_rack = splitEven(qty, racks);
        break;
      case 'terminations_div_ports':
        if (tr.terminations == null) { note = 'terminations not in WF2'; break; }
        qty = Math.ceil(Number(tr.terminations) / pv(r, 'ports_per_switch'));
        if (racks > 0 && r.params?.split_even?.v) per_rack = splitEven(qty, racks);
        break;
      case 'per_panel': qty = tr.panels == null ? null : Math.ceil(Number(tr.panels) * pv(r, 'each')); if (qty == null) note = 'patch panels not in WF2'; break;
      case 'per_wall_mount':
        if (tr.wall_mount == null) { note = 'nothing entered for this TR in WF5 (wall-mount checkbox)'; break; }
        qty = tr.wall_mount ? pv(r, 'each', 1) : 0; break;
      case 'not_stated': note = 'quantity not stated on the sheet'; break;
      default: note = `unknown method ${r.qty_rule}`;
    }
    const row = { rule_key: r.rule_key, ref: r.ref, item: r.item, part_number: r.part_number, qty, per_rack, note };
    out.push(row); byKey.set(r.rule_key, { rule: r, row });
  }
  // pass 2: unused RU = rack capacity − RU used by counted height items, switches and power
  for (const r of counted.filter((x) => x.qty_rule === 'unused_ru')) {
    const miss = missingParams(r);
    let qty = null, note = null;
    const cap = [...byKey.values()].find((x) => x.rule.params?.ru_role?.v === 'capacity' && x.rule.qty_rule === 'per_rack');
    if (requireConfirmed && !isConfirmed(r)) note = 'rule not confirmed';
    else if (racks == null) note = 'rack count not entered in WF5';
    else if (!(racks > 0)) qty = 0;
    else if (miss.length) note = 'set ' + miss.map((p) => PARAM_LABEL[p] || p).join(', ');
    else if (!cap || !cap.rule.ru) note = 'no rack RU on the sheet';
    else {
      let used = 0, unknown = [];
      for (const { rule, row } of byKey.values()) {
        if (rule.params?.ru_role?.v !== 'height') continue;
        if (row.qty == null) { unknown.push(rule.ref); continue; }
        used += row.qty * (rule.ru || 0);
      }
      const sw = [...byKey.values()].find((x) => x.rule.qty_rule === 'terminations_div_ports');
      if (sw && sw.row.qty == null) unknown.push(sw.rule.ref);
      else if (sw) used += sw.row.qty * pv(r, 'switch_ru');
      used += racks * pv(r, 'power_ru_per_rack');
      if (unknown.length) note = 'waits on ' + unknown.join(', ');
      else qty = Math.max(0, Math.floor((racks * cap.rule.ru - used) / (r.ru || 1)));
    }
    out.push({ rule_key: r.rule_key, ref: r.ref, item: r.item, part_number: r.part_number, qty, per_rack: null, note });
  }
  // capacity check against the elevation for this rack count
  let check = null;
  if (racks == null) check = { level: 'open', text: 'no rack count in WF5' };
  else if (racks === 0) check = { level: 'none', text: tr.wall_mount ? 'wall-mount TR' : 'no new racks' };
  else {
    const c = capacityFor(elevations, racks);
    if (!c) check = { level: 'warn', text: `no typical ${racks}-rack elevation on the sheet` };
    else if (c.passive != null && tr.terminations != null && Number(tr.terminations) > c.passive)
      check = { level: 'warn', text: `${tr.terminations} outlets > ${c.passive} on ${racks} rack${racks > 1 ? 's' : ''}` };
    else check = { level: 'ok', text: `within ${racks}-rack capacity` };
  }
  return { tr_name: tr.tr_name, racks, items: out, check };
}

export function summaryOf(rules, sized) {
  const userMissing = rules.filter((r) => r.note_kind !== 'drawing').reduce((n, r) => n + missingParams(r).length, 0);
  const userSet = rules.reduce((n, r) => n + Object.values(r.params || {}).filter((p) => p && p.source === 'user' && p.v != null && p.v !== '').length, 0);
  const counting = rules.filter(countsSomething);
  return {
    rules_counting: counting.length,
    confirmed: counting.filter(isConfirmed).length,
    coded: rules.filter((r) => r.note_kind === 'coded' && !r.rule_key.includes('-')).length,
    user_set: userSet, user_missing: userMissing,
    trs: sized.length,
    over_capacity: sized.filter((s) => s.check?.level === 'warn').length,
    waits_wf7: sized.filter((s) => s.items.some((i) => /WF7/.test(i.note || ''))).length,
  };
}
