// detect.js — pure label detector for the v2 detection contract.
// No PDF, no DOM, no network. Imported by both index.html and the multi-page
// pipeline, and called server-side by pass-extract / pass-batch.
//
// Replaces the bespoke outlet chain (parseLabelFamilies / splitOverMerge /
// deduplicateInstances). One ANCHOR token == one device instance. Families are
// attached as enrichment only; reconcile owns any merge.
//
// Input text_items (from PDF.js text layer, normalized): [{ str, cx_norm, cy_norm }]
// Input config (device_types.detection_config): { type|name, anchor, anchor_mode,
//   uin_pattern?, families?, fam_radius? }
// Output instance (consumed by reconcile): { uin, type, x, y, families, codes }

const leadAlpha = (s) => (String(s).match(/^[A-Z]+/) || [''])[0];

// A token is a "family code" if its leading letters are one of the config families
// AND it carries a numeric suffix (DV1, DD2, N2) — bare words never qualify.
function isFamilyCode(str, families) {
  const s = String(str).trim().toUpperCase();
  if (!/\d/.test(s)) return false;
  const lead = leadAlpha(s);
  return families.includes(lead);
}

/**
 * Detect instances of ONE device type from the text layer.
 * @param {Array}  textItems  [{ str, cx_norm, cy_norm }]
 * @param {Object} config     detection_config for this type (+ type/name)
 * @param {Object} opts       { famRadius } normalized family-attach radius
 * @returns {Array} instances for this type
 */
export function detectLabels(textItems = [], config = {}, opts = {}) {
  const type = config.type || config.name;
  const families = Array.isArray(config.families) ? config.families : [];
  const famRadius = opts.famRadius ?? config.fam_radius ?? 0.04;
  const mode = config.anchor_mode === 'regex' ? 'regex' : 'exact';

  // Build the anchor matcher.
  let matches;
  if (mode === 'exact') {
    const A = String(config.anchor).trim().toUpperCase();
    matches = (s) => s === A;
  } else {
    // regex mode: uin_pattern is the precise matcher when present, else anchor.
    const re = new RegExp(config.uin_pattern || config.anchor);
    matches = (s) => re.test(s);
  }

  // Find anchor tokens — each is exactly one device.
  const anchors = [];
  for (const t of textItems) {
    const s = String(t.str).trim().toUpperCase();
    if (!s) continue;
    if (matches(s)) anchors.push({ s, x: t.cx_norm, y: t.cy_norm });
  }

  // Attach family codes to anchors by NEAREST anchor (not every anchor in radius),
  // so a token from a neighboring faceplate can't be claimed by two devices. The
  // anchor token itself (e.g. N2 when 'N' is a family) is the anchor, not a family
  // member, so it's excluded from the family codes here.
  const anchorStr = mode === 'exact' ? String(config.anchor).trim().toUpperCase() : null;
  const famTokens = families.length
    ? textItems
        .filter((t) => isFamilyCode(t.str, families))
        .map((t) => ({ s: String(t.str).trim().toUpperCase(), x: t.cx_norm, y: t.cy_norm }))
    : [];

  const bucket = anchors.map(() => []);
  for (const f of famTokens) {
    let bi = -1, bd = famRadius;                 // only consider tokens within the radius
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      // a token sitting exactly on an anchor of the same string IS that anchor — skip it
      if (f.s === a.s && Math.abs(f.x - a.x) < 1e-6 && Math.abs(f.y - a.y) < 1e-6) { bi = -1; break; }
      const d = Math.hypot(f.x - a.x, f.y - a.y);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) bucket[bi].push(f.s);
  }

  return anchors.map((a, i) => {
    const codes = [...new Set(bucket[i])].filter((c) => c !== a.s);  // dedupe + drop the anchor token
    const fams = [...new Set(codes.map(leadAlpha))];
    return {
      // regex/prefix tokens are unique per device -> they ARE the UIN.
      // exact anchors (N2/WAP/180) repeat -> no UIN; reconcile collapses by coordinate.
      uin: mode === 'regex' ? a.s : null,
      type,
      x: a.x,
      y: a.y,
      families: fams,
      codes,
    };
  });
}

/** Run the detector across every configured device type and concatenate. */
export function detectAll(textItems = [], deviceTypes = [], opts = {}) {
  const out = [];
  for (const dt of deviceTypes) {
    const cfg = dt.detection_config;
    if (!cfg || !cfg.anchor) continue; // un-migrated types are skipped (need discovery/backfill)
    const merged = { ...cfg, type: cfg.type || dt.name };
    out.push(...detectLabels(textItems, merged, opts));
  }
  return out;
}

export default detectLabels;
