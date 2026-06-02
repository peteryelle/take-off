// sheet-class.js — the ingest PROBE: tag each sheet {vector_text, vector_geometry,
// raster_only} so downstream tracks branch on how a sheet is encoded rather than
// discovering it by failing. No DOM, no network, no PDF import. The pure classifier
// takes already-gathered counts; the signal gatherer takes an INJECTED pdf.js page
// (same seam as geometry.js), so the browser hands it the CDN build and the offline
// gate hands it pdfjs-dist. The live pipeline never gains a server-side PDF dep.
//
// Passive by design (substep 4): the probe writes pages.sheet_class at load and
// nothing branches on it yet. The locator (substep 5) is the first consumer:
//   vector_text  -> read devices/UINs straight from the text layer (detect/schedule)
//   vector_geometry -> the deterministic symbol classifier (signature.js) is usable
//   raster_only  -> neither layer present: OCR + full-vision fallback, flagged lower-conf
// raster_only is the DERIVED state where both vector flags are false — it is never a
// positive detection, just the absence of a usable text or vector layer.
//
// Thresholds are calibrated against real sheets (see fixtures/sheet-class-signals.json):
// QTS_1page = 1031 text chars / 255 filled sub-paths / ~1.1M path ops; VA = 6855 chars.
// A scanned sheet sits near zero on both. Wide margins, so the exact cutoffs aren't knife-edge.

const DEFAULTS = { textMin: 100, geomFillsMin: 10, geomOpsMin: 200 };

/**
 * Classify a sheet's encoding from gathered signal counts. Pure.
 * @param {Object} signals
 *   { textCharCount=0, filledSubpathCount=0, constructPathOps=0, imageCount=0, imageAreaFrac=0 }
 * @param {Object} opts { textMin, geomFillsMin, geomOpsMin }
 * @returns {{ vector_text, vector_geometry, raster_only, signals }}
 */
export function classifySheetClass(signals = {}, opts = {}) {
  const { textMin, geomFillsMin, geomOpsMin } = { ...DEFAULTS, ...opts };
  const textCharCount = signals.textCharCount ?? 0;
  const filledSubpathCount = signals.filledSubpathCount ?? 0;
  const constructPathOps = signals.constructPathOps ?? 0;

  const vector_text = textCharCount >= textMin;
  // OR of two geometry signals: filled sub-paths (cheap, from the adapter) OR raw
  // path ops — so a line-art-only sheet (few fills, many strokes) still reads vector.
  const vector_geometry = filledSubpathCount >= geomFillsMin || constructPathOps >= geomOpsMin;
  const raster_only = !vector_text && !vector_geometry;

  return {
    vector_text,
    vector_geometry,
    raster_only,
    signals: {
      textCharCount,
      filledSubpathCount,
      constructPathOps,
      imageCount: signals.imageCount ?? 0,
      imageAreaFrac: signals.imageAreaFrac ?? 0,
    },
  };
}

/**
 * Gather sheet-class signals from an opened pdf.js page (pdf.js injected). Reuses the
 * geometry adapter's operator walker for the filled-sub-path count, so the probe and
 * the symbol track agree on what "vector geometry" means. Impure only in that it reads
 * the page; no PDF library is imported here.
 *
 * @param {Object} page  opened pdf.js page
 * @param {Object} OPS   that runtime's pdfjsLib.OPS
 * @param {Object} deps  { extractFilledSubpaths } injected from geometry.js
 * @returns {Promise<Object>} signals for classifySheetClass
 */
export async function deriveSheetClassSignals(page, OPS, deps = {}) {
  const tc = await page.getTextContent({ includeMarkedContent: false });
  let textCharCount = 0;
  for (const it of tc.items) {
    const s = (it.str || '').replace(/[^\x20-\x7E]/g, '').trim();
    if (s) textCharCount += s.length;
  }

  const { fnArray } = await page.getOperatorList();
  const IMG = [OPS.paintImageXObject, OPS.paintInlineImage, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((x) => x != null);
  let constructPathOps = 0, imageCount = 0;
  for (const fn of fnArray) {
    if (fn === OPS.constructPath) constructPathOps++;
    if (IMG.includes(fn)) imageCount++;
  }

  let filledSubpathCount = 0;
  if (typeof deps.extractFilledSubpaths === 'function') {
    const subs = await deps.extractFilledSubpaths(page, OPS);
    filledSubpathCount = subs.length;
  }

  return { textCharCount, filledSubpathCount, constructPathOps, imageCount, imageAreaFrac: 0 };
}

export default classifySheetClass;
