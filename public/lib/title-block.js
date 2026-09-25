// public/lib/title-block.js
// Reads a drawing sheet's title block from positioned text, and suggests the
// v2 page role. Pure (no PDF, no DOM) so it runs in the browser and in tests.
//
// Input items are pdf.js text runs normalised to the page:
//   { s: string, x: 0..1 (left→right), y: 0..1 (top→bottom), h: font size }
//
// Strategy: find values by their LABELS ("Drawing Number", "Drawing Title",
// "Building Number"), which survive layout changes between designers better
// than fixed positions. Where a label is missing, fall back to the largest
// sheet-number-shaped text in the bottom-right, where title blocks live.
// Nothing here is final: every value is shown to the user to confirm.
// ─────────────────────────────────────────────────────────────────

import { classifyPageRole } from './classify-page-role.js';

const SHEET_NO = /^[A-Z]{1,3}[-.]?\d[\w.\-]*$/i; // T1.1.A, T-501, TD402A, E-101
const LABEL = {
  number: /^(drawing|sheet)\s*(number|no\.?|#)$/i,
  title: /^(drawing|sheet)\s*title$/i,
  building: /^(building|bldg)\s*(number|no\.?|#)?$/i,
};

const near = (a, b, dx, dy) => Math.abs(a.x - b.x) <= dx && b.y > a.y - 0.004 && b.y - a.y <= dy;

// Values sit below or beside their label, in a larger font.
function valuesUnder(items, label, { dx = 0.06, dy = 0.03, minH = 0 } = {}) {
  return items
    .filter((i) => i !== label && !isLabel(i.s) && i.h >= minH && near(label, i, dx, dy))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
const isLabel = (s) => Object.values(LABEL).some((re) => re.test(s.trim()));

export function readSheetNumber(items) {
  for (const lab of items.filter((i) => LABEL.number.test(i.s.trim()))) {
    const cands = valuesUnder(items, lab, { dx: 0.05, dy: 0.04 })
      .filter((i) => SHEET_NO.test(i.s.trim()))
      .sort((a, b) => b.h - a.h);
    if (cands.length) return { value: cands[0].s.trim(), via: 'label' };
  }
  // Fallback: largest sheet-number-shaped run in the bottom-right quarter.
  const br = items
    .filter((i) => i.x > 0.75 && i.y > 0.8 && SHEET_NO.test(i.s.trim()) && /[A-Z]/i.test(i.s))
    .sort((a, b) => b.h - a.h);
  return br.length ? { value: br[0].s.trim(), via: 'position' } : { value: null, via: null };
}

export function readTitle(items) {
  for (const lab of items.filter((i) => LABEL.title.test(i.s.trim()))) {
    // Title lines sit under the label and to its right; text further left is
    // a neighbouring block (e.g. an agency logo) and is excluded.
    const lines = valuesUnder(items, lab, { dx: 0.08, dy: 0.04, minH: lab.h * 1.2 })
      .filter((i) => i.x >= lab.x - 0.005);
    if (lines.length) return lines.map((i) => i.s.trim()).join(' ').replace(/\s+/g, ' ');
  }
  return null;
}

export function readBuildingLabel(items) {
  for (const lab of items.filter((i) => LABEL.building.test(i.s.trim()))) {
    const v = valuesUnder(items, lab, { dx: 0.04, dy: 0.02 })
      .find((i) => /^(\d{1,3}[A-Z]?|[A-Z]\d{1,3})$/i.test(i.s.trim()));
    if (v) return v.s.trim();
  }
  return null;
}

// Revision: filename first ("…-Rev.1.pdf"), else none — the user confirms.
export function readRevision(filename = '') {
  const m = String(filename).match(/\bREV\.?\s*[-_]?\s*([0-9]+|[A-Z])\b/i);
  return m ? `Rev.${m[1].toUpperCase()}` : null;
}

// Building / level / zone from the title and sheet number.
export function readLocation(title, sheetNumber, buildingLabel) {
  const t = String(title || '').toUpperCase();
  const out = { building: null, level: null, zone: null };
  const b = t.match(/\bBLDG\.?\s*([\w-]+)/) || t.match(/\bBUILDING\s+([\w-]+)/);
  if (b) out.building = `BLDG-${b[1]}`;
  else if (buildingLabel) out.building = `BLDG-${buildingLabel}`;
  const l = t.match(/\b(?:LV|LEVEL)\s*([\w,]+)/) ||
            t.match(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH)\s+FLOOR\b/) ||
            t.match(/\b(BASEMENT|GROUND)\b/);
  if (l) out.level = LEVEL_WORD[l[1]] || l[1];
  const z = t.match(/\bZONES?\s+([A-Z0-9][A-Z0-9,& ]*?)(?=\s+-|\s*$)/);
  if (z && !/^ZONES\b/.test(z[0])) out.zone = z[1].replace(/\s+/g, '');
  // Sheet number like T1.5.K -> level 5, zone K (only fills blanks).
  // Sheet number like T1.5.K -> level 5, zone K; T1.B -> level B (only fills blanks).
  const s = String(sheetNumber || '').toUpperCase().match(/^[A-Z]+\d\.([0-9B])(?:\.?([A-Z][A-Z0-9]*))?$/);
  if (s) {
    if (!out.level) out.level = s[1];
    if (!out.zone && s[2]) out.zone = s[2];
  }
  return out;
}
const LEVEL_WORD = { FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6', BASEMENT: 'B', GROUND: 'G' };

// v2 roles. Title phrases specific to the workflow are checked first; the
// repo's proven classifier covers the rest and its roles are mapped across.
const V2_TITLE_RULES = [
  { role: 'osp_overview', re: /\bSITE\b.*\b(FIBER|TELECOM|COMMUNICATIONS?)\b.*\bOVERALL\b|\bOVERALL\b.*\bSITE\b/ },
  { role: 'osp_route', re: /\bSITE\b.*\b(FIBER|TELECOM|COMMUNICATIONS?)\b.*\b(ROUTING|PLAN|ZONE)\b|\bOUTSIDE PLANT\b|\bOSP\b/ },
  { role: 'key_plan', re: /\bZONES\b|\bKEY PLAN\b|\bOVERALL\b.*\bFLOOR PLAN\b/ },
  { role: 'legend', re: /\bLEGEND\b|\bABBREV/ },
  { role: 'notes', re: /\bGENERAL NOTES\b|\bPHASING\b|\bSPECIFICATIONS?\b/ },
  { role: 'schedule', re: /\bSCHEDULES?\b/ },
  { role: 'tr_room', re: /\bENLARGED\b.*\b(DATA ROOMS?|TELECOM|TR)\b|\bTELECOM(MUNICATIONS)? ROOMS?\b/ },
  { role: 'rack', re: /\bRACK ELEVATIONS?\b|\bRACK DETAILS?\b/ },
  { role: 'riser', re: /\bRISER\b|\bTELECOM DIAGRAMS?\b|\bBACKBONE\b/ },
  { role: 'detail', re: /\bDETAILS?\b|\bTYPICAL\b/ },
  { role: 'plan', re: /\bNEW WORK\b|\bFLOOR PLAN\b|\bZONE\b|\bPLAN\b/ },
];
const OLD_TO_V2 = { plan: 'plan', schedule: 'schedule', legend: 'legend', detail: 'detail', tr_room: 'tr_room' };

export function suggestRole(title, lines = []) {
  const t = String(title || '').toUpperCase().replace(/\s+/g, ' ');
  if (t) {
    for (const r of V2_TITLE_RULES) if (r.re.test(t)) return { role: r.role, confidence: 'high', via: 'title' };
  }
  const old = classifyPageRole({ lines });
  const role = OLD_TO_V2[old.role] || null;
  if (!role) return { role: null, confidence: 'low', via: 'none' };
  return { role, confidence: old.confidence === 'high' ? 'medium' : 'low', via: 'classifier' };
}

// One call for a page.
export function readTitleBlock(items, filename = '') {
  const number = readSheetNumber(items);
  const title = readTitle(items);
  const lines = items.map((i) => i.s);
  const role = suggestRole(title, lines);
  // The Building Number box is only meaningful on plan sheets; on schedules and
  // details it can hold unrelated text.
  const buildingLabel = ['plan', 'key_plan'].includes(role.role) ? readBuildingLabel(items) : null;
  const loc = readLocation(title, number.value, buildingLabel);
  return {
    sheet_number: number.value,
    sheet_number_via: number.via,
    title,
    rev_label: readRevision(filename),
    ...loc,
    suggested_role: role.role,
    role_confidence: role.confidence,
  };
}

// Text fingerprint for duplicate and "unchanged since the reference" checks.
// The same sheet exported on its own or inside a combined PDF carries the same
// text split into DIFFERENT runs ("...THIS SHEET AR" + "E APPROXIMATE..." vs
// one run), so the key must ignore how text is split and ordered: it counts
// every non-space character on the page. Any added or removed text changes it.
// Not seen (v1): pure linework changes, and text moved without being changed.
export function pageTextKey(items) {
  const counts = new Map();
  for (const i of items) for (const ch of String(i.s)) if (!/\s/.test(ch)) counts.set(ch, (counts.get(ch) || 0) + 1);
  return [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c}${n}`).join('|');
}
