// frame.js — pure coordinate-frame transform for the two normalization frames
// this pipeline uses. No PDF, no DOM, no network.
//
// A device's x/y lives in one of two frames depending on its xy_source:
//   - identity (full-page fraction, 0..1 across the whole rendered page):
//     symbol+llm (pass-symbol.js strip-locate, normalizes against the full
//     rendered page image) and manual (confidence-map click position).
//   - content-bbox (fraction WITHIN the page's text-content bounding box,
//     which is usually smaller than the full page — architectural sheets
//     routinely have real content start/end well inside the PDF's MediaBox):
//     label, symbol+vector, and leader — everything else.
//
// Anything that compares two devices' coordinates, or a device against a
// region drawn in one specific frame (exclude zones and demarc pins are
// always drawn in identity frame), MUST transform into a shared frame first.
// Comparing raw values across the two frames without transforming is silent —
// no error, just numbers that don't quite line up — and has caused real bugs:
// an exclude-zone cull box (identity frame) failing to suppress re-detection
// of the very device it was drawn around (content-bbox frame, uncompared).

/**
 * Does this device's x/y already live in the identity (full-page) frame?
 * @param {Object} dev { xy_source, symbol_via }
 */
export function usesIdentityFrame(dev) {
  return (dev?.xy_source === 'symbol' && dev?.symbol_via !== 'vector') || dev?.xy_source === 'manual';
}

/**
 * Convert a device's x/y into the identity (full-page) frame. A no-op for
 * devices already in that frame, or when no content_bbox is available (in
 * which case content-bbox devices pass through unconverted — the caller's
 * comparison may be off, but this degrades to the old always-identity
 * behavior rather than throwing).
 *
 * @param {{x:number,y:number,xy_source?:string,symbol_via?:string}} dev
 * @param {{xmin_frac:number,ymin_frac:number,w_frac:number,h_frac:number}|null} contentBBox
 * @returns {[number|null, number|null]}
 */
export function toIdentityXY(dev, contentBBox) {
  if (dev?.x == null || dev?.y == null) return [dev?.x ?? null, dev?.y ?? null];
  if (usesIdentityFrame(dev) || !contentBBox) return [dev.x, dev.y];
  const { xmin_frac = 0, ymin_frac = 0, w_frac = 1, h_frac = 1 } = contentBBox;
  return [xmin_frac + dev.x * w_frac, 1 - ymin_frac - (1 - dev.y) * h_frac];
}

export default { usesIdentityFrame, toIdentityXY };
