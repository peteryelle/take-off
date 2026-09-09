// public/lib/discover-tr-schedule.js — proposes a complete pages.tr_schedule
// config (locator + columns + tolerances) from a page's raw text_items alone.
// No PDF, no DOM, no network, no LLM.
//
// This closes the gap tr-schedule.js's own file header names: locator,
// columns, and tolerances were all hand-authored for VA's T-500 (via SQL,
// via chat). A future AE's TR schedule shouldn't need that — this is the
// "no-reinvent engine" piece for tr_summary, mirroring how discover-config.js
// already turns a legend read into device-type config, except the schedule
// case here needs no LLM at all: a schedule table's title and header are
// just text already sitting in text_items. Same reasoning that already
// governs schedule/detail/legend page-role classification (classify-page-role.js
// looks for the literal word "SCHEDULE" in a sheet title) — reused here to
// find candidate TABLE titles on the page, since AE drawing convention names
// these tables "... SCHEDULE" near-universally (QTS "DETAIL SCHEDULE", APG
// "OUTLET QUANTITY SCHEDULE", VA "... HARDWARE SCHEDULE", "CAMERA SCHEDULE").
//
// A real sheet can have MORE THAN ONE such table (T-500 has two: the TR
// schedule and the Camera Schedule). This scans every "...SCHEDULE" title on
// the page, extracts each candidate's header tokens, classifies EACH one via
// classify-archetype.js, and only proposes a config for whichever candidate
// actually scores as tr_summary — never guesses if none does, or if more than
// one does (a config ambiguous enough to tie is exactly the case that should
// go to a human, not get silently resolved).

import { classifyTable, HEADER_PATTERNS } from './classify-archetype.js';

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
const SCHEDULE_TITLE = /\bSCHEDULE\b/;

// Group items into columns by x proximity (same approach as tr-schedule.js).
function groupCols(items, colTol) {
  const sorted = [...items].sort((a, b) => a.cx_norm - b.cx_norm);
  const cols = [];
  for (const it of sorted) {
    let placed = false;
    for (const c of cols) {
      if (Math.abs(it.cx_norm - c.cx) <= colTol) {
        c.items.push(it);
        c.sum += it.cx_norm; c.cx = c.sum / c.items.length;
        placed = true; break;
      }
    }
    if (!placed) cols.push({ cx: it.cx_norm, sum: it.cx_norm, items: [it] });
  }
  return cols;
}

// Find every "...SCHEDULE" title on the page and its y position. Deliberately
// single-item only, not a multi-item reading-order join: on a dense sheet
// (see tr-schedule.js's file header for how tight T-500's real spacing gets)
// items from genuinely different tables can share near-identical y, so a
// bounded join risks stitching two unrelated tables' text into one false
// "title" containing the word SCHEDULE from either side. Real title text
// comes through as one span in practice (confirmed against T-500's own two
// table titles). Missing a title that happens to be split across items is a
// safe failure — it just means no candidate found, not a false match. The
// sheet's own title-block ("TELECOM SCHEDULES" as the drawing's name, not a
// table) also matches this word and is a real false positive on T-500 — it's
// rejected downstream by extractCandidateTable requiring an actual
// multi-column table beneath the candidate, which the title block has none of.
function findScheduleTitles(textItems) {
  const seen = new Set();
  const titles = [];
  for (const it of textItems) {
    const t = norm(it.str);
    if (SCHEDULE_TITLE.test(t) && !seen.has(t)) {
      seen.add(t);
      titles.push({ title: t, x: it.cx_norm, y: it.cy_norm });
    }
  }
  return titles.sort((a, b) => a.y - b.y);
}

// Two schedule tables can sit in the same tight vertical band on one sheet
// (T-500: Camera Schedule and the TR schedule are side by side, not stacked —
// their titles are only ~0.018 apart in y). A pure "below this title" cutoff
// lets one table's header/data bleed into the other's candidate extraction.
// Assigning each item to whichever title is closest IN X treats each title as
// governing its own table's column corridor, which is what actually
// separates two side-by-side tables (a y-only cutoff can't).
function nearestTitleIndex(item, titles) {
  let best = 0, bestD = Infinity;
  titles.forEach((t, i) => {
    const d = Math.abs(item.cx_norm - t.x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// Loosely locate a candidate table's header row beneath a title, WITHOUT
// assuming known column labels (unlike tr-schedule.js, which is told exactly
// which labels to look for). Bootstraps with a generous headerBandTol first,
// then reports the real measured gaps so calibrateTolerances can derive safe,
// sheet-specific numbers rather than reusing another sheet's tuning.
function extractCandidateTableFromRegion(region, opts = {}) {
  // Bootstrap probes start from tr-schedule.js's PROVEN real-sheet tolerances,
  // not a looser guess. A generous 0.03 was tried first here and it promptly
  // reproduced the exact failure that motivated those tighter numbers in the
  // first place: it merged BUILDING+LEVEL (real gap ~0.027, under a 0.03
  // probe) and pulled the first data row into the header band. If a
  // different AE's real spacing genuinely is looser, calibrateTolerances
  // below measures that from THIS pass's real gaps and adjusts — the probe
  // only has to be a reasonable start, not a safe upper bound.
  const rowTolProbe = opts.rowTolProbe ?? 0.010;
  const headerBandProbe = opts.headerBandProbe ?? 0.010;
  const colTolProbe = opts.colTolProbe ?? 0.012;

  if (!region.length) return null;

  // Header band: the first dense cluster of columns below the title. Real
  // header text sits close together (VA: ~0.005-0.014 span); a generous
  // headerBandProbe catches multi-line wraps without needing to know the
  // labels in advance, at the cost of possibly reaching into the first data
  // row too -- harmless here since we only need column X positions and TEXT
  // for classification, not a strict content match the way tr-schedule.js's
  // headerXBand requires.
  const bandTopY = Math.min(...region.map((it) => it.cy_norm));
  const band = region.filter((it) => it.cy_norm <= bandTopY + headerBandProbe);
  const cols = groupCols(band, colTolProbe).sort((a, b) => a.cx - b.cx);
  if (cols.length < 2) return null; // not a real multi-column table

  const headerTokens = cols.map((c) =>
    norm([...c.items].sort((a, b) => a.cy_norm - b.cy_norm).map((it) => it.str).join(' '))
  );

  // Real column gaps -> for colTol calibration (half the tightest real gap).
  const colXs = cols.map((c) => c.cx);
  const colGaps = [];
  for (let i = 1; i < colXs.length; i++) colGaps.push(colXs[i] - colXs[i - 1]);

  // Real header-line-wrap span -> for headerBandTol calibration.
  const headerYs = band.map((it) => it.cy_norm);
  const headerSpan = Math.max(...headerYs) - Math.min(...headerYs);
  const headerBottomY = Math.max(...headerYs);

  // Real data-row-to-row gap -> for rowTol calibration. Look at the next two
  // rows below the header using a tight probe (data rows on a real schedule
  // are single lines, not wrapped).
  const dataRegion = region.filter((it) => it.cy_norm > headerBottomY + rowTolProbe / 2);
  const dataYs = [...new Set(dataRegion.map((it) => it.cy_norm))].sort((a, b) => a - b);
  const rowGaps = [];
  for (let i = 1; i < Math.min(dataYs.length, 6); i++) rowGaps.push(dataYs[i] - dataYs[i - 1]);

  return { headerTokens, colGaps, headerSpan, rowGaps, colXs };
}

// Derive safe tolerances from measured real spacing, with a floor so an
// unusually dense or sparse sheet doesn't collapse to zero or blow up.
function calibrateTolerances({ colGaps, headerSpan, rowGaps }) {
  const minColGap = colGaps.length ? Math.min(...colGaps) : 0.03;
  const minRowGap = rowGaps.length ? Math.min(...rowGaps) : 0.012;
  return {
    colTol: Math.max(minColGap * 0.4, 0.004),
    rowTol: Math.max(minRowGap * 0.6, 0.004),
    // Header line-wrap span is usually tighter than a data-row gap; pad it a
    // little beyond what was actually observed so a slightly taller wrap on
    // a different page of the same set doesn't fall just outside the window.
    headerBandTol: Math.max(headerSpan * 1.5, minRowGap * 0.5, 0.004),
  };
}

// Map a candidate's header tokens to the tr-schedule.js column-config shape.
// Returns null if the required columns (tr_number, terminations,
// patch_panels) don't all resolve -- caller treats that as "not this table."
function mapColumns(headerTokens) {
  const find = (re) => headerTokens.find((h) => re.test(h)) || null;
  const tr_number = find(HEADER_PATTERNS.ROOM_KEY_HEADERS.find((re) => headerTokens.some((h) => re.test(h))) || /$^/);
  const terminations = find(HEADER_PATTERNS.TERMINATIONS_HEADER);
  const patch_panels = find(HEADER_PATTERNS.PATCH_PANELS_HEADER);
  const building = find(HEADER_PATTERNS.BUILDING_HEADER);
  const level = find(HEADER_PATTERNS.LEVEL_HEADER);
  if (!tr_number || !terminations || !patch_panels) return null;
  return { tr_number, terminations, patch_panels, building, level };
}

/**
 * @param {Array} textItems  [{ str, cx_norm, cy_norm }] for one page
 * @returns {{ config: Object|null, candidates: Array, reasons: [str] }}
 *   config: a ready-to-store pages.tr_schedule value, or null if no
 *     candidate table on the page confidently classifies as tr_summary.
 *   candidates: every "...SCHEDULE"-titled table found and how it classified
 *     — surfaced for human review regardless of outcome (transparency into
 *     what discovery considered and rejected, not just the winner).
 */
export function proposeTrScheduleConfig(textItems = []) {
  const titles = findScheduleTitles(textItems);
  const candidates = [];

  for (let i = 0; i < titles.length; i++) {
    const { title, y } = titles[i];
    // This candidate's own corridor: items below its title, AND x-nearest to
    // THIS title rather than any other found on the page (see
    // nearestTitleIndex — what actually separates two side-by-side tables).
    const region = textItems.filter((it) =>
      it.cy_norm > y + 0.005 && nearestTitleIndex(it, titles) === i
    );
    const extracted = extractCandidateTableFromRegion(region);
    if (!extracted) {
      candidates.push({ title, archetype: 'unknown', reasons: ['no multi-column table found beneath title'] });
      continue;
    }
    const classified = classifyTable({ headers: extracted.headerTokens, idColumnValues: [] });
    candidates.push({ title, archetype: classified.archetype, reasons: classified.reasons, headerTokens: extracted.headerTokens, extracted });
  }

  const winners = candidates.filter((c) => c.archetype === 'tr_summary');
  if (winners.length !== 1) {
    return {
      config: null,
      candidates,
      reasons: winners.length === 0
        ? ['no candidate table classified as tr_summary']
        : [`${winners.length} candidate tables classified as tr_summary — ambiguous, needs human review`],
    };
  }

  const winner = winners[0];
  const columns = mapColumns(winner.headerTokens);
  if (!columns) {
    return { config: null, candidates, reasons: ['tr_summary winner missing a required column (tr_number/terminations/patch_panels)'] };
  }

  const tolerances = calibrateTolerances(winner.extracted);
  const config = {
    present: true,
    locator: `table titled '${winner.title}'`,
    columns,
    tolerances,
  };
  return { config, candidates, reasons: ['proposed from single unambiguous tr_summary candidate'] };
}

export default proposeTrScheduleConfig;
