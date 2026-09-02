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
  // When uin_pattern is set, also collect prefix-matching tokens that fail the
  // pattern (bare "FP", "FP*" chips) as flagged candidates — they are NOT counted.
  const anchors = [];
  const flaggedCandidates = [];
  const hasUinPattern = !!(config.uin_pattern && mode === 'regex');
  const prefix = hasUinPattern ? String(config.anchor).trim().toUpperCase() : null;
  for (const t of textItems) {
    const s = String(t.str).trim().toUpperCase();
    if (!s) continue;
    if (matches(s)) { anchors.push({ s, x: t.cx_norm, y: t.cy_norm }); }
    else if (hasUinPattern && s.startsWith(prefix)) {
      flaggedCandidates.push({ token: s, type, x: t.cx_norm, y: t.cy_norm, flag: 'prefix_only' });
    }
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

  const result = anchors.map((a, i) => {
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
  if (flaggedCandidates.length) result.flaggedCandidates = flaggedCandidates;
  return result;
}

/** Run the detector across every configured device type and concatenate. */
export function detectAll(textItems = [], deviceTypes = [], opts = {}) {
  const out = [];
  const flagged = [];
  for (const dt of deviceTypes) {
    const cfg = dt.detection_config;
    if (!cfg || !cfg.anchor) continue; // un-migrated types are skipped (need discovery/backfill)
    const merged = { ...cfg, type: cfg.type || dt.name };
    const instances = detectLabels(textItems, merged, opts);
    out.push(...instances);
    if (instances.flaggedCandidates) flagged.push(...instances.flaggedCandidates);
  }
  if (flagged.length) out.flaggedCandidates = flagged;
  return out;
}

// disambiguateByAdjacentCount — splits a shared text anchor into count-suffixed
// variants (e.g. base "W" WAP anchor vs. a "(2) W" 2-port variant) using ONLY the
// text layer already on hand. No image, no vision call, no network.
//
// Why this exists: detectLabels' exact-anchor matcher does `s === A`, so a
// compound label like "(2) W" is invisible to it UNLESS the PDF's text extraction
// splits the parenthesized count and the letter into separate text items sitting
// side-by-side — which is exactly what happens on these sheets. The bare "W" half
// of that split then matches the base anchor indistinguishably from a genuinely
// bare "W". This function looks at what sits immediately to the anchor's left and
// reclassifies accordingly.
//
// Calibrated against a real sheet (Gainesville EHRM T1.1.A, fixtures/
// va-voip-wall-disambiguate-t11a.json): a "(2)"->"W" pair sits exactly 0.00429
// normalized units apart (dx, dy=0) every time; the nearest unrelated neighbor to
// any bare "W" is never closer than 0.0074. The default radius sits in that gap.
//
// Variant device_types are found via detection_config.disambiguate_from = <base
// device_types.id> and must have no anchor of their own (Step 6 discovery leaves
// them anchor-less on purpose — they're not independently detectable). The port
// count is parsed straight from the variant's own name ("...2 PORT" -> 2), so no
// extra schema field is needed.
//
// @param {Array} textItems    [{ str, cx_norm, cy_norm }]
// @param {Array} instances    output of detectAll/detectLabels — [{ type, x, y, ... }]
// @param {Array} deviceTypes  [{ id, name, detection_config }]
// @param {Object} opts        { disambigRadius, disambigDy }
// @returns {Array} instances, same shape, with .type swapped onto the matched
//   variant where applicable. Carries .flaggedCandidates for a count token found
//   adjacent to an anchor but with no matching variant configured (e.g. a "(3)"
//   on a sheet where only the 2-port variant exists) — flagged rather than
//   silently dropped or silently left misclassified.
export function disambiguateByAdjacentCount(textItems = [], instances = [], deviceTypes = [], opts = {}) {
  const radius = opts.disambigRadius ?? 0.006;
  const dyTol  = opts.disambigDy ?? 0.0015;
  const countRe = /^\((\d+)\)$/;

  // base device_types.id -> [{ count, type }], derived from disambiguate_from +
  // a "<N> PORT" match on the variant's own name.
  const variantsByBase = new Map();
  for (const dt of deviceTypes) {
    const cfg = dt.detection_config;
    const baseId = cfg?.disambiguate_from;
    if (baseId == null) continue;
    const m = /(\d+)\s*PORT/i.exec(dt.name);
    if (!m) continue; // no derivable count -> nothing to key this variant on
    if (!variantsByBase.has(baseId)) variantsByBase.set(baseId, []);
    variantsByBase.get(baseId).push({ count: Number(m[1]), type: cfg.type || dt.name });
  }
  if (!variantsByBase.size) return instances; // nothing configured to disambiguate into

  // type-string -> base device_types.id, so we know which instances are eligible.
  const baseTypeToId = {};
  for (const dt of deviceTypes) {
    if (variantsByBase.has(dt.id)) {
      const cfg = dt.detection_config;
      baseTypeToId[cfg.type || dt.name] = dt.id;
    }
  }

  const countTokens = textItems
    .map((t) => ({ raw: String(t.str).trim(), x: t.cx_norm, y: t.cy_norm }))
    .filter((t) => countRe.test(t.raw));

  const flagged = [];
  const out = instances.map((inst) => {
    const baseId = baseTypeToId[inst.type];
    if (baseId == null) return inst; // not a disambiguation-eligible anchor type

    let best = null, bd = Infinity;
    for (const tok of countTokens) {
      const dx = inst.x - tok.x;             // count token sits to the LEFT of the anchor
      const dy = Math.abs(inst.y - tok.y);
      if (dx > 0 && dx <= radius && dy <= dyTol) {
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = tok; }
      }
    }
    if (!best) return inst; // no adjacent count token -> stays the base type

    const n = Number(countRe.exec(best.raw)[1]);
    const variant = variantsByBase.get(baseId).find((v) => v.count === n);
    if (!variant) {
      flagged.push({ ...inst, flag: `adjacent_count_${n}_no_variant_configured` });
      return inst; // leave as base rather than silently mis-splitting or dropping it
    }
    return { ...inst, type: variant.type };
  });

  if (flagged.length) out.flaggedCandidates = [...(instances.flaggedCandidates || []), ...flagged];
  return out;
}

export default detectLabels;
