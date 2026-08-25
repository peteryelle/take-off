// public/lib/tr-reference.js — extracts cross-sheet TR (telecom room) references
// from a page's own coded-note text, e.g. "...CONNECTED BACK TO NEW PATCH PANELS
// IN TR H335-1." This is the text half of TR registry resolution: it tells the
// app WHICH TR a page's devices should route to when that TR isn't drawn on this
// sheet. It never resolves a coordinate itself — pairing the extracted name
// against another page's already-confirmed serving demarc (done in
// multi-page.html, see wireTrReferences) is what makes it actionable, and only
// after a human confirms via the existing suggestExitPin/suggestAllExitPins flow
// does a pin actually get written. Confirmed across all 9 real plan sheets in
// the Gainesville EHRM set (T1.3.J/H/D/C/B/A/E/K/U) — every sheet with an
// off-sheet TR uses this exact phrasing.
//
// Deliberately narrow: matches ONE coded-note convention. A sheet phrased
// differently returns null — silence, not a wrong guess — same "flag, don't
// guess" discipline as pass-b-page.js's off-sheet demarc handling. If a
// different AE firm's drawings use different wording, extend the pattern list
// below rather than loosening this one to match everything.

const TR_REF_PATTERNS = [
  /PATCH PANELS IN TR\s+([A-Z0-9][A-Z0-9\-]*)/i,
];

// Room-name-shaped result only — filters out the alternate phrasing this same
// AE firm uses on multi-TR sheets ("...IN TR LOCATED IN BUILDING, REFER TO
// PLANS FOR TR LOCATIONS."), which matches the pattern's first word but isn't
// a real TR name.
const NOT_A_NAME = new Set(['LOCATED', 'REFER', 'THE', 'ALL']);

/**
 * @param {string} pageText  raw extracted text for one page (whitespace can be
 *   irregular — same text pass-b-page.js already has in hand from the text pass)
 * @returns {string|null}  the referenced TR name (e.g. "H335-1"), or null if no
 *   match, or the match isn't a real room-name shape
 */
export function extractTrReference(pageText) {
  if (!pageText) return null;
  const flat = pageText.replace(/\s+/g, ' ');
  for (const pattern of TR_REF_PATTERNS) {
    const m = flat.match(pattern);
    if (!m) continue;
    const name = m[1].toUpperCase();
    if (NOT_A_NAME.has(name)) continue;
    return name;
  }
  return null;
}

export default { extractTrReference };
