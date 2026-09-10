// public/lib/stitch-runs.js — reassembles pdf.js's raw, unmerged per-run
// text extraction into logical strings. No PDF, no DOM, no network.
//
// pdf.js's getTextContent() returns the PDF's raw text-showing operators
// exactly as the authoring tool wrote them — unlike PyMuPDF's higher-level
// "dict" mode, which merges same-line runs automatically. Confirmed against
// a real production capture: T-500's own 56-character table title, and an
// unrelated footer sentence, both came through pdf.js split into multiple
// separate runs at the PDF-authoring level (common for Revit/AutoCAD
// exports), not because of any client-side filtering.
//
// Originally inline in multi-page.html (added to fix that exact bug), moved
// here because it's a pure function with zero DOM dependency and was the
// wrong place for it to live — multi-page.html is already large enough that
// anything reusable/testable in isolation belongs in its own module instead
// of growing that file further.

/**
 * @param {Array} rawItems  [{ s, cy, left, right, fs }] — one entry per raw
 *   pdf.js text item BEFORE any merging. cy: vertical center. left/right:
 *   horizontal extent. fs: font size (PDF points).
 * @param {Object} opts  { yTol, gapSpaceFrac, maxMergeFrac }
 *   yTol: PDF-point tolerance for "same line" (default 1.0).
 *   gapSpaceFrac: × font size -> gap large enough to insert a space between
 *     merged runs, rather than concatenating directly (default 0.15).
 *   maxMergeFrac: × font size -> gap beyond which two same-line items stop
 *     being merged at all (default 1.0). This ceiling matters as much as
 *     gapSpaceFrac: without it, this merged real, separate table columns
 *     ("BUILDING NUMBER" + "LEVEL", an 11pt gap at font-size 10) into one
 *     string during testing. A genuine inter-word space within wrapped
 *     prose is a few points at most; a column-to-column gap in a drawn
 *     table is sized for cell content and is typically much wider than one
 *     font-height. One font-height as the cutoff kept the real
 *     word-boundary case (3pt gap, correctly merges) and rejected the real
 *     column case (11pt gap, correctly stays separate).
 * @returns {Array<{ s: string, cx: number, cy: number }>}
 */
export function stitchRuns(rawItems, opts = {}) {
  const yTol = opts.yTol ?? 1.0;
  const gapSpaceFrac = opts.gapSpaceFrac ?? 0.15;
  const maxMergeFrac = opts.maxMergeFrac ?? 1.0;

  const sorted = [...rawItems].sort((a, b) => a.cy - b.cy || a.left - b.left);
  const merged = [];
  let cur = null;
  for (const it of sorted) {
    const gap = cur ? it.left - cur.right : null;
    const fs = (cur?.fs) || 10;
    if (cur && Math.abs(it.cy - cur.cy) <= yTol && gap <= fs * maxMergeFrac) {
      cur.s = cur.s + (gap > fs * gapSpaceFrac ? ' ' : '') + it.s;
      cur.right = Math.max(cur.right, it.right);
    } else {
      if (cur) merged.push(cur);
      cur = { s: it.s, cy: it.cy, left: it.left, right: it.right, fs: it.fs };
    }
  }
  if (cur) merged.push(cur);
  return merged.map((r) => ({ s: r.s, cx: (r.left + r.right) / 2, cy: r.cy }));
}

export default stitchRuns;
