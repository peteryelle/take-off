// classify-page-role.js — pure page-role classifier for set-level ingestion.
// No PDF, no DOM, no network.
//
// A drawing set mixes page roles: plan sheets (devices live here), schedule
// sheets (counts/UINs live here), legend/abbreviation sheets (type vocabulary),
// and detail/elevation sheets (enlargements — not counted). Set orchestration
// (step 4) needs each page tagged so it routes the page to the right work:
// plans -> detect/symbol, schedules -> the archetype readers, legends ->
// discovery, details -> skip.
//
// Measured across three AEs, the reliable signal is the SHEET TITLE phrase
// (in the title block), corroborated by structure:
//   - "... PLAN"                  -> plan        (+ scale bar, room numbers)
//   - "... SCHEDULE" / grand total -> schedule
//   - "LEGEND"/"ABBREVIATIONS"     -> legend
//   - "DETAIL"/"ELEVATION"/"TYPICAL"/"NTS" -> detail
//
// Raw keyword frequency is NOT reliable (dense abbreviation text repeats "PLAN"
// dozens of times; schedule sheets say "ENLARGED ... PLAN"). So we score TITLE
// PHRASES, not token counts, and report the primary role plus alternates — a
// page can host several titled tables (e.g. an OUTLET QUANTITY SCHEDULE and a
// CABINET SCHEDULE on one sheet), which step 4 routes per-table.

const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');

// Title-phrase patterns -> role. Order matters only for tie display; scoring is
// additive. Each pattern is matched against extracted title-like phrases.
const TITLE_PATTERNS = [
  { role: 'schedule', re: /\bSCHEDULE\b/ },
  { role: 'legend',   re: /\b(LEGEND|ABBREVIATION|ABBREVIATIONS|SYMBOLS?)\b/ },
  { role: 'detail',   re: /\b(DETAIL|ELEVATION|TYPICAL|ENLARGED|RISER|DIAGRAM)\b/ },
  { role: 'plan',     re: /\bPLAN\b/ },
];
const ROLE_WORD = /\b(PLAN|SCHEDULE|LEGEND|ABBREVIATION|ABBREVIATIONS|SYMBOL|SYMBOLS|DETAIL|ELEVATION|TYPICAL|ENLARGED|RISER|DIAGRAM|NOTES)\b/;

// Extract title-like phrases: short, mostly-uppercase lines naming a role. These
// approximate the title-block / table-title text without needing geometry.
export function extractTitlePhrases(lines = []) {
  const out = [];
  for (const raw of lines) {
    const s = String(raw).trim();
    if (!s || s.split(/\s+/).length > 8) continue;
    if (!ROLE_WORD.test(s.toUpperCase())) continue;
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (!letters.length) continue;
    const upperFrac = [...letters].filter((c) => c === c.toUpperCase()).length / letters.length;
    if (upperFrac >= 0.6) out.push(norm(s));
  }
  return [...new Set(out)];
}

/**
 * @param {Object} page
 *   { titlePhrases?: [str], lines?: [str],  // provide one; lines -> extractTitlePhrases
 *     hasGrandTotal?: bool, hasScaleBar?: bool, roomNumberCount?: number,
 *     abbreviationDensity?: number }        // structural corroboration (optional)
 * @returns {{ role, score, scores, alternates, titlePhrases }}
 */
export function classifyPageRole(page = {}) {
  const titlePhrases = page.titlePhrases
    ? page.titlePhrases.map(norm)
    : extractTitlePhrases(page.lines || []);

  const scores = { plan: 0, schedule: 0, legend: 0, detail: 0 };
  const reasons = [];

  // Title phrases: a phrase naming a role scores that role. A phrase can only
  // grant ONE role (first matching pattern), so "ENLARGED TELECOM PLAN" scores
  // detail (enlarged), not plan — matching how engineers read it.
  for (const phrase of titlePhrases) {
    for (const { role, re } of TITLE_PATTERNS) {
      if (re.test(phrase)) { scores[role] += 2; reasons.push(`title "${phrase}" -> ${role}`); break; }
    }
  }

  // Structural corroboration.
  if (page.hasGrandTotal) { scores.schedule += 2; reasons.push('grand-total row -> schedule'); }
  if (page.hasScaleBar) { scores.plan += 1; reasons.push('scale bar -> plan'); }
  if ((page.roomNumberCount || 0) >= 15) { scores.plan += 1; reasons.push(`${page.roomNumberCount} room numbers -> plan`); }
  if ((page.abbreviationDensity || 0) >= 20) { scores.legend += 2; reasons.push('high abbreviation density -> legend'); }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [winner, runnerUp] = ranked;
  if (winner[1] <= 0) {
    return { role: 'unknown', confidence: 'low', needs_user: true, score: 0, scores, alternates: [], titlePhrases, reasons };
  }
  const alternates = ranked.slice(1).filter(([, v]) => v > 0).map(([r]) => r);

  // Confidence from margin: a clear winner is high; a thin lead over the
  // runner-up is low and escalates to the user (who can assign the role). We
  // deliberately do NOT strain to disambiguate noisy title blocks — wrong-but-
  // confident is worse than flagged-for-review on a takeoff.
  const margin = winner[1] - (runnerUp ? runnerUp[1] : 0);
  let confidence;
  if (margin >= 4) confidence = 'high';
  else if (margin >= 2) confidence = 'medium';
  else confidence = 'low';
  const needs_user = confidence === 'low';

  return { role: winner[0], confidence, needs_user, score: winner[1], scores, alternates, titlePhrases, reasons };
}

export default classifyPageRole;
