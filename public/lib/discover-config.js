// discover-config.js — the deterministic half of discovery (the "no-reinvent engine").
// No PDF, no DOM, no network, no LLM. The LLM legend read (pass-discover.js)
// produces the candidate types; this turns them into v2 detection_config rows by
// frequency-confirming anchors against a legend-derived list and deriving the
// UIN pattern from the observed token structure.
//
// Candidate (from the legend/image read):
//   { name, kind: 'exact'|'prefix', anchor, families?, legend_present, has_symbol, description? }
//     exact  -> anchor is the once-per-device token (N2, WAP, 180)
//     prefix -> anchor is the type prefix; instances are UIN'd (CAM-EXT-1, SF1)
//
// Output: { types: [{ name, detection_config }], schedule: <block|null> }

const leadAlpha = (s) => (String(s).match(/^[A-Z]+/) || [''])[0];
const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');

// Map a schedule header row to the contract's column block.
function mapScheduleColumns(scheduleInput) {
  const headers = (scheduleInput.headerTokens || []).map(norm);
  const find = (re) => headers.find((h) => re.test(h)) || null;
  const uin = find(/^UIN$/) || find(/\bUIN\b/);
  const detail = find(/DETAIL\s*SHEET/);
  const cable = headers.filter((h) => /CABLE\s*DEST/.test(h));
  if (!uin) return null;                       // no UIN column -> not a device schedule
  return {
    present: true,
    locator: `table titled '${(scheduleInput.locatorTitle || 'DETAIL SCHEDULE').toUpperCase()}'`,
    columns: { uin, detail_sheet: detail, cable_dest: cable },
    type_from: 'uin_prefix',
  };
}

/**
 * @param {Array}  candidates    legend/image-read candidate types
 * @param {Array}  planTokens    all plan text tokens (strings)
 * @param {Object} scheduleInput { present, headerTokens?, locatorTitle? } | null
 * @returns {{ types: Array, schedule: Object|null }}
 */
export function buildCatalog(candidates = [], planTokens = [], scheduleInput = null) {
  const toks = planTokens.map((t) => norm(t)).filter(Boolean);
  const schedulePresent = !!(scheduleInput && scheduleInput.present);
  const schedule = schedulePresent ? mapScheduleColumns(scheduleInput) : null;

  const types = candidates.map((c) => {
    const anchor = norm(c.anchor);
    let anchor_mode, uin_pattern = null, matcher;

    if (c.kind === 'exact') {
      anchor_mode = 'exact';
      matcher = (t) => t === anchor;             // exact token; "INSTALL" can't match "N2"
    } else {
      anchor_mode = 'regex';
      // Structured tokens for this prefix: leadAlpha matches AND there's more than
      // the bare prefix (a dash or a numeric suffix). Prose words ("ADDITIONAL")
      // have leadAlpha === the whole word, so they never match the prefix.
      const structured = toks.filter((t) =>
        leadAlpha(t) === anchor && t.length > anchor.length &&
        (t.includes('-') || /\d/.test(t.slice(anchor.length))));
      const allDigitSuffix = structured.length > 0 &&
        structured.every((t) => new RegExp(`^${anchor}\\d+$`).test(t));
      uin_pattern = allDigitSuffix ? `^${anchor}\\d+$` : `^${anchor}-[\\w-]+$`;
      const re = new RegExp(uin_pattern);
      matcher = (t) => re.test(t);
    }

    const freq = toks.filter(matcher).length;

    // sources: schedule covers UIN'd (prefix) types; label always; symbol if a glyph exists.
    const sources = [];
    if (schedulePresent && c.kind === 'prefix') sources.push('schedule');
    sources.push('label');
    if (c.has_symbol) sources.push('symbol');

    // confidence: legend + frequency -> high; frequency only -> medium; nothing -> low (re-derive).
    const anchor_confidence = (c.legend_present && freq > 0) ? 'high' : (freq > 0 ? 'medium' : 'low');

    const detection_config = {
      version: 2,
      sources,
      anchor,
      anchor_mode,
      uin_pattern,
      symbol_template: null,                      // Step 7 fills this from the legend glyph
      match_tolerance: 0.05,
      families: c.families || [],
      anchor_confidence,
      name_source: c.legend_present ? 'legend_match' : 'frequency',
      source: c.legend_present ? 'legend' : 'frequency',
    };

    return { name: c.name, detection_config, _freq: freq };
  });

  return { types, schedule };
}

export default buildCatalog;

// ── Anchor nomination ──────────────────────────────────────────────
// The legend/vision read gives a raw candidate (name, nearby_text codes,
// approximate_count, optional legend prefix). For prefix jobs the legend hands
// the prefix directly; for multi-code outlets with no legend (VA), the anchor is
// nominated by frequency — the single token that recurs ~once per device.
const baseOf = (s) => (String(s).match(/^[A-Z]+/) || [''])[0];

/**
 * @param {Object} raw  { name, nearby_text?, legend_prefix?, legend_present?|legend_name?, approximate_count?, has_symbol? }
 * @param {Array}  planTokens
 * @returns {Object} candidate for buildCatalog: { name, kind, anchor, families, legend_present, has_symbol }
 */
export function nominateAnchor(raw, planTokens = []) {
  const toks = planTokens.map((t) => norm(t)).filter(Boolean);
  const approx = raw.approximate_count ?? null;
  const codes = (raw.nearby_text || []).map((x) => norm(x)).filter(Boolean);
  const legendPrefix = raw.legend_prefix ? norm(raw.legend_prefix) : null;
  const has_symbol = !!raw.has_symbol;
  const legend_present = !!(raw.legend_present ?? raw.legend_name);
  const bases = [...new Set(codes.map(baseOf))].filter(Boolean);
  const families = bases.length > 1 ? bases : [];

  // A true UIN prefix shows up as dash-separated tokens (CAM-EXT-1). A family
  // code (DD2, base+digit, no dash) is NOT a prefix — that's what separates the
  // QTS prefix job from the VA family case.
  const dashCount = (pref) => toks.filter((t) => baseOf(t) === pref && t.includes('-')).length;
  const prefCands = [...new Set([legendPrefix, ...bases].filter(Boolean))]
    .map((p) => ({ p, c: dashCount(p) })).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);

  if (prefCands.length) {
    const pref = prefCands[0].p;
    return { name: raw.name, kind: 'prefix', anchor: pref,
             families: bases.filter((b) => b !== pref), legend_present, has_symbol };
  }

  // Exact nomination: the most frequent specific token per base, then the base
  // whose best token is closest to the device count (the once-per-device tag).
  const exactFreq = (tok) => toks.filter((t) => t === tok).length;
  const best = [];
  for (const base of bases) {
    let tok = null, f = 0;
    for (const t of new Set(toks)) {
      if (baseOf(t) !== base) continue;
      const c = exactFreq(t);
      if (c > f) { f = c; tok = t; }
    }
    if (tok) best.push({ token: tok, freq: f });
  }
  if (!best.length) for (const code of codes) { const f = exactFreq(code); if (f > 0) best.push({ token: code, freq: f }); }
  best.sort((a, b) => (approx != null ? Math.abs(a.freq - approx) - Math.abs(b.freq - approx) : b.freq - a.freq));

  if (best.length) return { name: raw.name, kind: 'exact', anchor: best[0].token, families, legend_present, has_symbol };
  return { name: raw.name, kind: 'exact', anchor: codes[0] || legendPrefix || norm(raw.name), families, legend_present, has_symbol };
}

/** Full discovery: nominate anchors from raw candidates, then build the catalog. */
export function discoverCatalog(rawCandidates = [], planTokens = [], scheduleInput = null) {
  const candidates = rawCandidates.map((rc) => nominateAnchor(rc, planTokens));
  return buildCatalog(candidates, planTokens, scheduleInput);
}
