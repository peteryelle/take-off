// public/lib/wf-schedule.js
// WF2 · Schedule logic. Pure; runs in the browser (free — no LLM) and in tests.
//
// Reuses the repo's proven T-500 reader unchanged:
//   stitchRuns            (stitch-runs.js)          — join split text runs
//   proposeTrScheduleConfig (discover-tr-schedule.js) — find the table + columns
//   parseTrSchedule       (tr-schedule.js)          — read the rows
// The text prep below is the same normalisation tr-schedule-review.html uses,
// so results match what that page has already been validated against.
//
// T-500 carries five columns: building, level, TR number, total Cat6A
// terminations, minimum patch panels. Racks, wire managers, room sheet and
// status are NOT on it — they come from WF5 (room plans) and WF6 (T-501).
// ─────────────────────────────────────────────────────────────────

import { stitchRuns } from './stitch-runs.js';
import { proposeTrScheduleConfig } from './discover-tr-schedule.js';
import { parseTrSchedule } from './tr-schedule.js';
import { normalizeTrName } from './normalize-tr-name.js';

// pdf.js getTextContent().items + page viewport (scale 1) -> reader items.
export function scheduleItemsFromTextContent(tcItems, viewport) {
  const raw = [];
  for (const item of tcItems || []) {
    const s0 = item.str?.trim();
    if (!s0) continue;
    const s = s0.replace(/[^\x20-\x7E]/g, '').trim();
    if (!s) continue;
    const tx = item.transform[4], ty = item.transform[5];
    const fs = Math.abs(item.transform[3]);
    const tw = item.width ?? 0, th = item.height ?? fs;
    raw.push({ s, cx: tx + tw / 2, cy: ty + th / 2, left: tx, right: tx + tw, fs });
  }
  if (!raw.length) return [];
  const xs = raw.map((i) => i.cx), ys = raw.map((i) => i.cy);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const cW = Math.max(xMax - xMin, viewport.width);
  const cH = Math.max(yMax - yMin, viewport.height);
  return stitchRuns(raw).map((it) => ({
    str: it.s,
    cx_norm: parseFloat(((it.cx - xMin) / cW).toFixed(4)),
    cy_norm: parseFloat((1 - (it.cy - yMin) / cH).toFixed(4)),
  }));
}

// Read the TR schedule from one page's items.
export function readTrSchedule(items) {
  const proposal = proposeTrScheduleConfig(items);
  if (!proposal.config) {
    return { rows: [], found: false, reasons: proposal.reasons, tables: proposal.candidates.map((c) => c.title) };
  }
  const rows = parseTrSchedule(items, proposal.config).map((r) => ({
    tr_number: r.tr_number,
    building: r.building,
    level: r.level,
    cat6a_terminations: r.total_terminations,
    min_patch_panels: r.min_patch_panels,
  }));
  return { rows, found: true, title: proposal.config.locator, reasons: proposal.reasons, tables: proposal.candidates.map((c) => c.title) };
}

export const TR_FIELDS = ['building', 'level', 'cat6a_terminations', 'min_patch_panels'];

// Compare a fresh read with the TRs already saved. Matching uses the
// punctuation-insensitive TR name, so "B050C1" vs "B050C-1" is the same room,
// not a removal plus an addition.
export function diffTrRows(saved = [], proposed = []) {
  const key = (r) => normalizeTrName(r.tr_number);
  const savedBy = new Map(saved.map((r) => [key(r), r]));
  const propBy = new Map(proposed.map((r) => [key(r), r]));
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [k, p] of propBy) {
    const s = savedBy.get(k);
    if (!s) { added.push(p); continue; }
    const diffs = TR_FIELDS
      .filter((f) => String(s[f] ?? '') !== String(p[f] ?? ''))
      .map((f) => ({ field: f, from: s[f] ?? null, to: p[f] ?? null }));
    if (diffs.length) changed.push({ tr_number: p.tr_number, saved: s, proposed: p, diffs });
    else unchanged.push(p);
  }
  for (const [k, s] of savedBy) if (!propBy.has(k)) removed.push(s);
  return { added, removed, changed, unchanged };
}

// Patch panels needed for a termination count at 48 ports per panel —
// used only to explain a changed termination count in plain words.
export const panelsFor = (terminations) => (terminations == null ? null : Math.ceil(Number(terminations) / 48));
