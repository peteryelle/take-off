// public/lib/wf7-riser.js
// WF7 Riser — read from the riser diagram sheet (the AE's "telecom diagrams").
// Pure (no DOM, no network): used by public/wf7.html, netlify/functions/wf7-riser.js
// and tests/test-wf7-riser.mjs.
//
// Nothing project-specific: no sheet numbers, TR names, strand counts or
// allowance quantities live here. Everything is read from the sheet's text
// layer; what can't be read with confidence is left for the user, and every
// item is confirmed before it is applied.
// ─────────────────────────────────────────────────────────────────────────────

import { parseCodedNotes } from './parse-coded-notes.js';
import { resolveTrMatch } from './normalize-tr-name.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ── riser blocks: one per RACK symbol label, with its TR label, floor and cores ──
export function readRiserBlocks(runs, opts = {}) {
  const dx = opts.blockWidth ?? 0.03;
  const out = [];
  for (const k of runs.filter((r) => clean(r.str) === 'RACK')) {
    const cores = runs.filter((r) => /^CORE [A-Z]$/.test(clean(r.str)) && r.cy_norm < k.cy_norm && k.cy_norm - r.cy_norm < 0.06
      && k.cx_norm - r.cx_norm > 0 && k.cx_norm - r.cx_norm < dx);
    if (!cores.length) continue;   // a RACK in some other diagram
    const coreInfo = {};
    for (const c of cores) {
      const letter = clean(c.str).slice(-1);
      const bubble = runs.filter((r) => /^\d{1,2}$/.test(clean(r.str)) && Math.abs(r.cy_norm - c.cy_norm) < 0.007
        && (c.left_norm ?? c.cx_norm) - r.cx_norm > 0 && (c.left_norm ?? c.cx_norm) - r.cx_norm < 0.02)
        .sort((a, b) => b.cx_norm - a.cx_norm)[0];
      coreInfo[letter] = bubble ? Number(clean(bubble.str)) : null;
    }
    // label lines below the rack (BLDG xx / TR yyy), floor words to the lower left
    const below = runs.filter((r) => r.cy_norm > k.cy_norm + 0.01 && r.cy_norm < k.cy_norm + 0.045 && Math.abs(r.cx_norm - k.cx_norm) < dx)
      .sort((a, b) => a.cy_norm - b.cy_norm);
    const FLOOR = /^(BASEMENT|GROUND|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ROOF|PENTHOUSE|MEZZANINE|\d+(ST|ND|RD|TH))\b|^(FLOOR|LEVEL)$/;
    const labelLines = below.filter((r) => !FLOOR.test(clean(r.str))).map((r) => clean(r.str));
    const floorRuns = runs.filter((r) => r.cy_norm > k.cy_norm && r.cy_norm < k.cy_norm + 0.04 && k.cx_norm - r.cx_norm > 0 && k.cx_norm - r.cx_norm < 0.05
      && FLOOR.test(clean(r.str))).sort((a, b) => a.cy_norm - b.cy_norm);
    const floor = clean(floorRuns.map((r) => clean(r.str)).join(' ')) || null;
    const trLine = labelLines.find((l) => /^(TR|ER|MDF|IDF|MCR)\b/.test(l)) || null;
    const building = labelLines.filter((l) => l !== trLine).join(' ') || null;
    const trName = trLine ? clean(trLine.replace(/^(TR|ER|MDF|IDF|MCR)\b\s*/, '')) : '';
    out.push({
      riser_key: [building, trLine].filter(Boolean).join(' | ') || `block@${k.cx_norm.toFixed(3)},${k.cy_norm.toFixed(3)}`,
      riser_label: trLine || labelLines.join(' '), building, floor,
      tr_name_read: trName || null,          // e.g. "A502-1"; null for "TR" with no number
      core_a_note: coreInfo.A ?? null, core_b_note: coreInfo.B ?? null,
      core_a: 'A' in coreInfo, core_b: 'B' in coreInfo,
      at: { x: k.cx_norm, y: k.cy_norm },
    });
  }
  // keys must be unique; a repeated label gets its position appended
  const seen = new Map();
  for (const b of out) { const n = (seen.get(b.riser_key) || 0) + 1; seen.set(b.riser_key, n); if (n > 1) b.riser_key += ` #${n}`; }
  return out;
}

// ── cable types from the coded notes ──
export function readCableNotes(runs) {
  return parseCodedNotes(runs).map((n) => {
    const t = clean(n.text).toUpperCase();
    const parts = [...t.matchAll(/(?:\(\d+\)\s*)?(\d+)[- ]STRANDS? (OS\d|OM\d)/g)].map((m) => ({ n: Number(m[1]), type: m[2] }));
    const why = [];
    let plant = null;
    if (/INDOOR\s*\/\s*OUTDOOR/.test(t)) why.push('indoor/outdoor');
    if (/LOOSE[- ]TUBE/.test(t)) why.push('loose tube');
    if (/GEL[- ]FILLED/.test(t)) why.push('gel-filled');
    if (/OUTSIDE PLANT|\bOSP\b/.test(t)) why.push('outside plant');
    if (why.length) plant = 'osp';
    else {
      if (/\bINDOOR\b/.test(t)) why.push('indoor');
      if (/TIGHT[- ]BUFFER/.test(t)) why.push('tight buffered');
      if (/INSIDE PLANT|\bISP\b/.test(t)) why.push('inside plant');
      if (why.length) plant = 'isp';
    }
    return {
      note_number: n.number, note_text: clean(n.text),
      strands: parts, strands_per_core: parts.length ? parts.reduce((s, p) => s + p.n, 0) : null,
      strands_text: parts.map((p) => `${p.n} ${p.type}`).join(' + ') || null,
      isp_osp: plant, basis: why.join(' · ') || null,
    };
  });
}

// Head-end callouts: "(60)" next to a note bubble "3", on a CORE A / CORE B line —
// that many cables of that coded note leave the head end on that core.
export function readHeadEnd(runs) {
  const out = [];
  for (const q of runs.filter((r) => /^\((\d+)\)$/.test(clean(r.str)))) {
    const note = runs.filter((r) => /^\d{1,2}$/.test(clean(r.str)) && Math.abs(r.cy_norm - q.cy_norm) < 0.004 && r.cx_norm > q.cx_norm && r.cx_norm - q.cx_norm < 0.012)
      .sort((a, b) => a.cx_norm - b.cx_norm)[0];
    if (!note) continue;
    const core = runs.filter((r) => /^CORE [A-Z]$/.test(clean(r.str)) && Math.abs(r.cy_norm - q.cy_norm) < 0.012 && q.cx_norm - r.cx_norm > 0 && q.cx_norm - r.cx_norm < 0.04)
      .sort((a, b) => Math.abs(a.cy_norm - q.cy_norm) - Math.abs(b.cy_norm - q.cy_norm))[0];
    out.push({ qty: Number(clean(q.str).slice(1, -1)), note_number: Number(clean(note.str)), core: core ? clean(core.str).slice(-1) : null });
  }
  return out;
}

// ── allowance notes ("CARRY AN ALLOWANCE FOR THE FOLLOWING:" + bullets) ──
function footToNumber(s) {
  const m = /(\d+)'\s*-?\s*(\d+)?"?/.exec(s);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0) : null;
}
export function readAllowances(runs) {
  const groups = [];
  const heads = runs.filter((r) => /CARRY AN ALLOWANCE/i.test(r.str));
  for (const h of heads) {
    const left = h.left_norm ?? h.cx_norm;
    const col = runs.filter((r) => r.cy_norm > h.cy_norm && r.cy_norm < h.cy_norm + 0.08 && (r.left_norm ?? r.cx_norm) >= left - 0.005 && (r.left_norm ?? r.cx_norm) < left + 0.2)
      .sort((a, b) => a.cy_norm - b.cy_norm);
    const bullets = [];
    let lastY = h.cy_norm;
    for (const r of col) {
      if (r.cy_norm - lastY > 0.012) break;     // end of the note
      const s = clean(r.str);
      if (/^[•·\-*]\s*/.test(s)) bullets.push(s.replace(/^[•·\-*]\s*/, ''));
      else if (bullets.length) bullets[bullets.length - 1] += ' ' + s;
      else break;
      lastY = r.cy_norm;
    }
    // system = the diagram title under/near this note
    const title = runs.filter((r) => /DIAGRAM\s*$/i.test(clean(r.str)) && r.cy_norm > h.cy_norm && r.cy_norm - h.cy_norm < 0.12 && Math.abs(r.cx_norm - h.cx_norm) < 0.15)
      .sort((a, b) => a.cy_norm - b.cy_norm)[0];
    const noteNo = (/^(\d+)\./.exec(clean(h.str)) || [])[1] || null;
    const system = title ? clean(title.str) : 'Allowance';
    // first bullet with "(N) NEW <thing>" sets the unit and its count
    let unitCount = null, unitLabel = null;
    const lines = bullets.map((b, i) => {
      const u = /PROVIDE\s*\((\d+)\)\s*(?:NEW\s+)?(.+?)\.?$/i.exec(b);
      if (u && unitCount == null) {
        unitCount = Number(u[1]); unitLabel = clean(u[2]).toLowerCase();
        return { i, text: b, per_unit_qty: 1, unit: 'ea', per_text: null, is_unit: true };
      }
      const each = /\bEACH\s+(?:NEW\s+)?([A-Z]+)/i.exec(b);
      const ft = footToNumber(b);
      if (ft != null && /'/.test(b)) return { i, text: b, per_unit_qty: Math.round(ft * 100) / 100, unit: 'ft', per_text: each ? `per ${each[1].toLowerCase().trim()}` : null };
      if (/PROVIDE\s+(?:A\s+|ONE\s+|\(1\)\s+)?NEW\b/i.test(b)) return { i, text: b, per_unit_qty: 1, unit: 'ea', per_text: each ? `per ${each[1].toLowerCase().trim()}` : null };
      return { i, text: b, per_unit_qty: null, unit: null, per_text: null };
    });
    const slug = system.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    groups.push({
      system, note_ref: noteNo ? `${system} · note ${noteNo}` : system, unit_count: unitCount, unit_label: unitLabel,
      lines: lines.map((l) => ({
        allowance_key: `${slug}-${l.i + 1}`, system, item: l.text, per_unit_qty: l.per_unit_qty, unit: l.unit,
        unit_count: l.is_unit ? unitCount : (l.per_text ? unitCount : null), per_text: l.is_unit ? null : l.per_text,
        note_ref: noteNo ? `${system} · note ${noteNo}` : system,
      })),
    });
  }
  return groups;
}

// ── matching riser TRs to the schedule (WF2) ──
// exact: same name, or same after punctuation (resolveTrMatch exact/stripped)
// close: an instance suffix or one letter differs — shown for the user to accept
const dropLetterBeforeSuffix = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[A-Z](1?)$/, '$1').replace(/([0-9])[A-Z](?=1$)/, '$1');
export function matchRiserTr(nameRead, trs) {
  if (!nameRead || !trs.length) return { kind: 'none', tr_name: null };
  const r = resolveTrMatch(nameRead, trs.map((t) => t.tr_number ?? t));
  if (r.match && (r.tier === 'exact' || r.tier === 'stripped')) return { kind: 'exact', tr_name: r.match };
  if (r.match) return { kind: 'close', tr_name: r.match, why: 'instance suffix differs' };
  const target = dropLetterBeforeSuffix(nameRead);
  const hits = trs.map((t) => t.tr_number ?? t).filter((n) => dropLetterBeforeSuffix(n) === target);
  if (hits.length === 1) return { kind: 'close', tr_name: hits[0], why: 'one letter differs' };
  return { kind: 'none', tr_name: null };
}

// Scope + status of every riser row against the schedule.
export function reconcile(feeds, trs) {
  const onSchedule = new Set(trs.map((t) => t.tr_number));
  const inFeeds = feeds.filter((f) => f.tr_name);
  const fed = new Set(inFeeds.map((f) => f.tr_name));
  return {
    riser: feeds.length,
    in: inFeeds.length,
    on_schedule: feeds.filter((f) => f.tr_name && f.match_kind !== 'added').length,
    added: feeds.filter((f) => f.match_kind === 'added').length,
    close: feeds.filter((f) => !f.tr_name && f.suggested_tr).length,
    out: feeds.filter((f) => !f.tr_name).length,
    schedule_without_feed: [...onSchedule].filter((n) => !fed.has(n)),
    duplicates: [...fed].filter((n) => inFeeds.filter((f) => f.tr_name === n).length > 1),
  };
}

// Type of a feed from its cores' cable notes (confirmed cable types only when asked).
export function feedType(feed, cables, opts = {}) {
  const byNote = new Map(cables.map((c) => [c.note_number, c]));
  const notes = [feed.core_a_note, feed.core_b_note].filter((n) => n != null);
  const types = [...new Set(notes.map((n) => byNote.get(n)).filter((c) => c && (!opts.confirmedOnly || c.confirmed_at)).map((c) => c.isp_osp).filter(Boolean))];
  if (!notes.length) return { isp_osp: null, why: 'no cable note on either core' };
  if (types.length > 1) return { isp_osp: null, why: 'core A and core B cables differ in type' };
  if (!types.length) return { isp_osp: null, why: opts.confirmedOnly ? 'cable type not confirmed' : 'cable type not set' };
  return { isp_osp: types[0], why: null };
}

export function feedBlocker(feed, cables) {
  if (feed.conflict) return feed.conflict.removed_from_sheet ? 'this TR is no longer on the riser sheet — take it out or keep it by setting its cores' : 'the sheet now reads differently — review the cores';
  if (!feed.tr_name) return feed.suggested_tr ? 'accept the schedule match or add it in first' : 'add it in first — it is not on the schedule';
  if (!feed.core_a_note && !feed.core_b_note) return 'no cable note read on either core — set one';
  const t = feedType(feed, cables, { confirmedOnly: true });
  if (!t.isp_osp) return t.why;
  return null;
}
export const cableBlocker = (c) => (c.conflict ? 'the sheet now reads differently — review it' : !c.isp_osp ? 'set ISP or OSP first' : null);
export const allowanceBlocker = (a) => (a.conflict ? 'the sheet now reads differently — review it' : a.per_unit_qty == null ? 'set the quantity per unit first' : a.unit_count == null ? 'set the unit count first' : null);

// Head end vs riser: for each head-end callout, count riser cores on the same core letter
// fed by a cable of the same kind (same strands and type). Read from the sheet only.
export function headEndCheck(headEnd, feeds, cables) {
  const byNote = new Map(cables.map((c) => [c.note_number, c]));
  const same = (a, b) => a && b && a.strands_text && a.strands_text === b.strands_text && (a.isp_osp || null) === (b.isp_osp || null);
  return headEnd.map((h) => {
    const hc = byNote.get(h.note_number);
    const key = h.core === 'B' ? 'core_b_note' : 'core_a_note';
    const riser = feeds.filter((f) => f[key] != null && f[key] !== h.note_number && same(byNote.get(f[key]), hc)).length;
    return { ...h, riser_cores: riser, same_as: [...new Set(feeds.map((f) => f[key]).filter((n) => n != null && n !== h.note_number && same(byNote.get(n), hc)))], ok: riser === h.qty };
  });
}
