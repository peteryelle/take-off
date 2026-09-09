// public/lib/normalize-tr-name.js — matches a TR room name as it appears on
// an enlarged-room floor plan (T-401 series title, e.g. "B050C-1") back to
// the tr_number spelling already stored from the T-500 schedule table (e.g.
// "B050C1"). No PDF, no DOM, no network.
//
// Confirmed on a real sheet (T-401, Gainesville EHRM) that the SAME AE,
// SAME project, uses inconsistent spellings for the same physical room
// across different sheets:
//   B050C-1 (T-401 title)  vs  B050C1  (T-500 tr_number)  -- hyphen only
//   C085A-1 (T-401 title)  vs  C085A1  (T-500 tr_number)  -- hyphen only
//   EB51A-1 (T-401 title)  vs  EB51A   (T-500 tr_number)  -- NOT just a
//     hyphen: T-401 appends a "-1" instance suffix that T-500 never had at
//     all for this one room, even hyphen-stripped ("EB51A1" != "EB51A").
//     Every other room's own "-1" suffix already matches T-500 exactly.
//
// So this is deliberately staged, not a single blanket strip: exact match
// first, then punctuation/whitespace-stripped, then (only if that still
// fails) a trailing "-1"/"1" instance suffix dropped from EACH side in turn.
// Never silently picks a match beyond that -- ambiguous or no match returns
// null with a reason, for a human to resolve (see resolveTrMatch below).

const stripPunctWs = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const dropTrailingInstanceSuffix = (s) => s.replace(/-?1$/, '');

// Accepts either bare tr_number strings or richer row objects (e.g. Supabase
// rows: { id, tr_number, ... }). Normalized internally as { raw, tr_number },
// so ambiguity results can hand back whatever the caller passed in -- an id
// to edit or delete, not just a name a human then has to go search for.
const asRow = (entry) => (typeof entry === 'string' ? { raw: entry, tr_number: entry } : { raw: entry, tr_number: entry.tr_number });

export function normalizeTrName(name) {
  return stripPunctWs(name);
}

/**
 * @param {string} floorPlanName   TR name as it appears on the enlarged-room
 *   drawing title (e.g. "EB51A-1")
 * @param {Array<string|Object>} scheduleRows  every tr_schedule_rows entry on
 *   file for this project -- plain tr_number strings, or row objects
 *   ({ id, tr_number, ... }) if the caller needs enough to edit/delete the
 *   colliding rows on an ambiguous result.
 * @returns {{ match: string|null, tier: string, reason?: string, candidates?: Array }}
 *   tier: 'exact' | 'stripped' | 'suffix-dropped' | 'none'
 *   candidates: present ONLY on an ambiguous result -- the actual colliding
 *     rows (whatever shape the caller passed in), for a human to review and
 *     resolve (edit one tr_number, or delete a genuine duplicate) rather
 *     than this function silently picking one.
 */
export function resolveTrMatch(floorPlanName, scheduleRows = []) {
  if (!floorPlanName || !scheduleRows.length) {
    return { match: null, tier: 'none', reason: 'empty input' };
  }
  const rows = scheduleRows.map(asRow);

  // Tier 1: exact string match.
  const exact = rows.find((r) => r.tr_number === floorPlanName);
  if (exact) return { match: exact.tr_number, tier: 'exact' };

  // Tier 2: strip spaces/punctuation from both sides, compare.
  const targetStripped = stripPunctWs(floorPlanName);
  const strippedHits = rows.filter((r) => stripPunctWs(r.tr_number) === targetStripped);
  if (strippedHits.length === 1) return { match: strippedHits[0].tr_number, tier: 'stripped' };
  if (strippedHits.length > 1) {
    return {
      match: null, tier: 'none',
      reason: `ambiguous: ${strippedHits.length} schedule rows match after stripping punctuation`,
      candidates: strippedHits.map((r) => r.raw),
    };
  }

  // Tier 3: floor-plan titles in this drawing set append a "-1" instance
  // suffix that doesn't always exist on the schedule side (EB51A case).
  // Only reached if tier 2 found nothing -- never overrides a tier-1/2 hit.
  const targetNoSuffix = dropTrailingInstanceSuffix(targetStripped);
  const suffixHits = rows.filter((r) => dropTrailingInstanceSuffix(stripPunctWs(r.tr_number)) === targetNoSuffix);
  if (suffixHits.length === 1) return { match: suffixHits[0].tr_number, tier: 'suffix-dropped' };
  if (suffixHits.length > 1) {
    return {
      match: null, tier: 'none',
      reason: `ambiguous: ${suffixHits.length} schedule rows match after dropping the instance suffix`,
      candidates: suffixHits.map((r) => r.raw),
    };
  }

  return { match: null, tier: 'none', reason: 'no schedule row matches at any tier -- flag for human review' };
}

export default resolveTrMatch;
