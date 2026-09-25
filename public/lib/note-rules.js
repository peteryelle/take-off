// public/lib/note-rules.js
// Finds the notes that change how another step checks or counts:
// pull-point spacing, cumulative bend limits, phasing references.
// Pure. Results are SUGGESTIONS the user confirms in WF1 — each carries the
// sheet, note number and exact wording it came from.
//
// The same kind of rule can differ by context: on the EHRM set, T-001 note 28
// limits pull-box spacing INSIDE buildings to 100', while T-108 note 1 limits
// manhole/handhole spacing OUTSIDE to 250'. Context decides which step uses it.
// ─────────────────────────────────────────────────────────────────

const OSP_WORDS = /\b(MANHOLES?|HANDHOLES?|DUCT ?BANK|DIRECT ?BURIED|SITE)\b/;

// Split notes text into numbered notes: "28. CONTRACTOR SHALL ..." -> { ref: '28', text }.
export function splitNumberedNotes(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const out = [];
  const re = /(?:^|\s)(\d{1,3})\.\s+(?=[A-Z])/g;
  const marks = [];
  let m;
  // Notes count up by one. "ANSI/TIA 569. MAXIMUM ..." looks like a note start
  // but is a standard's number, so only the next number in sequence is accepted.
  while ((m = re.exec(flat))) {
    const n = Number(m[1]);
    const prev = marks.length ? Number(marks[marks.length - 1].ref) : null;
    if (prev === null ? n <= 99 : n === prev + 1) marks.push({ ref: m[1], at: m.index + m[0].length, start: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : flat.length;
    out.push({ ref: marks[i].ref, text: flat.slice(marks[i].at, end).trim() });
  }
  return out;
}

export function findRules(text, sheetNumber = null) {
  const rules = [];
  for (const n of splitNumberedNotes(text)) {
    const t = n.text.toUpperCase();
    const isConduitLimit = /\b(PULL ?BOX|PULL ?POINT|MANHOLE|HANDHOLE|CONDUIT)\b/.test(t) && /\b(MAXIMUM|NOT TO EXCEED|SHALL NOT EXCEED)\b/.test(t);
    if (!isConduitLimit) continue;
    const osp = OSP_WORDS.test(t);
    const step = osp ? 'WF3' : 'WF4';
    const where = osp ? 'outside plant' : 'inside buildings';
    const ref = sheetNumber ? `${sheetNumber} note ${n.ref}` : `Note ${n.ref}`;
    const ft = t.match(/(\d{2,4})\s*(?:'|FT\b|FEET\b)/);
    if (ft) rules.push({ note_ref: ref, rule_kind: 'pull_limit_ft', rule_value: Number(ft[1]), used_by_step: step, where, note_text: n.text });
    const deg = t.match(/(\d{2,3})\s*DEGREES?/);
    if (deg) rules.push({ note_ref: ref, rule_kind: 'bend_limit_deg', rule_value: Number(deg[1]), used_by_step: step, where, note_text: n.text });
  }
  return rules;
}

// Sheets the notes point to, e.g. "T-002 GENERAL AND PHASING NOTES".
export function findPhasingSheetRefs(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').toUpperCase();
  const out = new Set();
  const re = /\b([A-Z]{1,2}-?\d{3}[A-Z]?)\s+[A-Z ,&]*PHASING\b/g;
  let m;
  while ((m = re.exec(flat))) out.add(m[1]);
  return [...out];
}
