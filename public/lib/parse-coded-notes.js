// public/lib/parse-coded-notes.js — extracts a sheet's "CODED NOTES:" legend
// into a structured, numbered list. No PDF, no DOM, no network.
//
// Why this exists: the ADD dropdown in the TR-room confidence map should
// offer whatever this SPECIFIC sheet's coded notes actually say a device can
// be ("PROVIDE 24" X 30" 45RU 4-POST EQUIPMENT RACK", "CONNECT NEW ACCESS
// CONTROL DEVICE...") rather than a fixed taxonomy. Coded-note numbering is
// sheet-local, not a stable convention across the drawing set — confirmed on
// real sheets in this same set: T-401's own notes don't necessarily carry
// the same meaning at the same number as a different enlarged-room sheet.
// Never assume "note 2 = rack" beyond the one sheet it was read from.
//
// Verified against a real sheet (T-401, Gainesville EHRM, 12 notes).

const norm = (s) => String(s).trim().replace(/\s+/g, ' ');

/**
 * @param {Array} textItems  [{ str, cx_norm, cy_norm }] for one sheet
 * @param {Object} opts  { titlePattern, rowTol, numberColTol }
 *   titlePattern: regex identifying the legend's own title. Default matches
 *     "CODED NOTES" (colon optional) case-insensitively.
 *   rowTol: y-tolerance for detecting distinct text lines within the legend
 *     (used only to order text within a note, not to bound the region).
 *   numberColTol: how close to the region's own left edge a bare 1-2 digit
 *     token must sit to count as a note-number marker, not a stray number
 *     embedded in note prose (e.g. "45RU", "18"W" never match — those are
 *     part of a longer token already, not a standalone digit span).
 * @returns {Array<{ number: number, text: string }>}
 */
export function parseCodedNotes(textItems = [], opts = {}) {
  const titlePattern = opts.titlePattern ?? /CODED\s*NOTES/i;
  const numberColTol = opts.numberColTol ?? 0.02;

  const titleItem = textItems.find((it) => titlePattern.test(it.str));
  if (!titleItem) return [];

  // Region: everything below the title, at or to the right of the title's
  // own x (small left margin for the number column, which sits slightly
  // left of the title's own text in practice) -- NOT a page-wide search,
  // which would pull in unrelated drawing content elsewhere on a dense sheet.
  const region = textItems.filter(
    (it) => it.cy_norm > titleItem.cy_norm && it.cx_norm > titleItem.cx_norm - 0.05
  );
  if (!region.length) return [];

  const leftEdge = Math.min(...region.map((it) => it.cx_norm));

  // Cap the legend column's own width. Confirmed on the real sheet: note body
  // text tops out around leftEdge+0.07; the sheet's own right-margin
  // grid-reference letters (A-F) sit at leftEdge+0.14, well beyond any real
  // note text. Without this, those letters get swept into whichever note's
  // y-window they happen to fall inside (note 4's body picked up a stray
  // "B"), and the LAST note's open-ended window (nothing bounds its end)
  // pulls in everything below it on the page -- the scale bar, title block,
  // page-border numbers, all the way to the bottom of the sheet.
  const maxColWidth = opts.maxColWidth ?? 0.10;
  const legendRegion = region.filter((it) => it.cx_norm <= leftEdge + maxColWidth);

  // A real note-number is a bare 1-2 digit token sitting near the region's
  // own left edge. Numbers embedded in prose ("45RU", "18\"W") are never
  // standalone tokens matching this, so they're not candidates at all --
  // the digit-only regex already excludes them without needing the position
  // check, but the position check is what stops a genuine standalone number
  // elsewhere in the note body (rare, but possible) from being read as a
  // second note-start.
  const numberCandidates = legendRegion.filter(
    (it) => /^\d{1,2}$/.test(it.str.trim()) && it.cx_norm <= leftEdge + numberColTol
  );
  if (!numberCandidates.length) return [];

  const starts = [...numberCandidates].sort((a, b) => a.cy_norm - b.cy_norm);

  // Stop at the first anomalously large gap. Real note-to-note marker
  // spacing on the one real sheet this was verified against ran ~0.01-0.025
  // (normalized); the jump to unrelated content further down the page
  // (sheet grid-reference letters, scale bar, title block -- all in the same
  // x-range as the legend, just much further down) was 0.6, ~25x any real
  // gap. A fixed multiple of the median real gap generalizes better than a
  // hardcoded absolute cutoff would across sheets with different legend
  // lengths/densities.
  const gaps = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i].cy_norm - starts[i - 1].cy_norm);
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const maxGap = opts.maxGapMultiple ?? 6;
  let cutoff = starts.length;
  for (let i = 1; i < starts.length; i++) {
    if (median > 0 && starts[i].cy_norm - starts[i - 1].cy_norm > median * maxGap) { cutoff = i; break; }
  }
  const validStarts = starts.slice(0, cutoff);

  // Small epsilon on the lower boundary: a note's own body text can render a
  // hair before its number marker's own y (sub-pixel glyph-height difference
  // on the same visual line, confirmed on a real sheet -- note 4's body text
  // sat at y=0.2428 vs its own marker at y=0.2429). Without this, that text
  // is misattributed to the PREVIOUS note instead.
  const yEps = opts.yEpsilon ?? 0.001;

  const notes = [];
  for (let i = 0; i < validStarts.length; i++) {
    const num = parseInt(validStarts[i].str, 10);
    const yStart = validStarts[i].cy_norm - yEps;
    // The LAST note has no next-note marker to bound it -- without a cap,
    // its window runs to Infinity and sweeps in everything else in the
    // legend column below it (scale bar, title block, page-border numbers,
    // confirmed on the real sheet). Capped at a generous multiple of the
    // real inter-note spacing rather than Infinity.
    const yEnd = i + 1 < validStarts.length
      ? validStarts[i + 1].cy_norm - yEps
      : validStarts[i].cy_norm + (median > 0 ? median * maxGap : 0.05);
    const bodyItems = legendRegion.filter(
      (it) => it.cy_norm >= yStart && it.cy_norm < yEnd && it !== validStarts[i]
    );
    const text = norm(
      [...bodyItems].sort((a, b) => a.cy_norm - b.cy_norm || a.cx_norm - b.cx_norm)
        .map((it) => it.str).join(' ')
    );
    if (text) notes.push({ number: num, text });
  }

  return notes.sort((a, b) => a.number - b.number);
}

export default parseCodedNotes;
