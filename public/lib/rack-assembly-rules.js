// rack-assembly-rules.js — T-501 rack hardware QUANTITIES for one TR. No PDF,
// no DOM, no network, no Excel-workbook logic ported in (that workbook has at
// least one confirmed structural error: it swapped T-501's own top/middle
// zone assignment relative to the drawing note text -- see this file's own
// header note below. Rules here are extracted fresh from T-501's coded notes
// and T-500's schedule, independently of that workbook).
//
// Deliberately says NOTHING about physical rack zone placement (top/middle/
// bottom third). T-501's Drawing Note 3 (text) says top=fiber+switches,
// middle=patch panels; the actual rack-elevation graphic's real y-coordinates
// (checked directly against the PDF) show the opposite -- patch panels above
// switching. Two sources on the same sheet disagree, and which one is
// authoritative doesn't change any of the quantities below, which is the
// thing this module is actually for. That discrepancy is a layout/rendering
// question for whoever draws the shop drawings, not a counting question.
//
// Every rule here is a real citation, not an inference:
//   - patch panel division: T-501 Drawing Note 2 ("divided as evenly as
//     possible between the number of racks")
//   - switch qty: T-501 Coded Note 7 (network switch, no stated 1:1-with-
//     panels relationship -- unlike the Excel workbook's now-superseded
//     assumption, this module does NOT assume 1 switch per rack; that
//     number isn't stated anywhere in T-501's text and should come from
//     wherever active-equipment counts actually get specified, not be
//     invented here)
//   - sidecar sharing: T-501 Coded Note 2 + the physical fact that a sidecar
//     mounts between two adjacent racks, shared
//   - fiber cassette qty: T-501 Coded Note 3, ceiling-divided from the
//     stated strand counts, NOT the workbook's flat "12 cassettes" assumption

/**
 * Patch panels, divided as evenly as possible across a TR's racks.
 * T-501 Drawing Note 2, verbatim: "IF TELECOM ROOM INDICATES MORE THAN (1)
 * RACK, NUMBER OF NETWORK SWITCHES AND PATCH PANELS ARE TO BE DIVIDED AS
 * EVENLY AS POSSIBLE BETWEEN THE NUMBER OF RACKS INDICATED IN THE ROOM."
 *
 * @param {number} totalPanels  T-500's "Minimum Number of Patch Panels" for this TR
 * @param {number} rackCount    from the TR-room floor-plan scan (leader-fan
 *   tracing), NOT from any other source -- see this session's own count-
 *   leadered-devices.js as the authoritative rack count.
 * @returns {number[]} one entry per rack, e.g. [4,4,3] for 11 panels / 3 racks
 */
export function distributePatchPanels(totalPanels, rackCount) {
  if (!(rackCount > 0)) return [];
  const base = Math.floor(totalPanels / rackCount);
  const remainder = totalPanels % rackCount;
  // First `remainder` racks get one extra panel -- same rounding convention
  // T-501's own note implies ("as evenly as possible"), just computed fresh
  // rather than trusted from the workbook.
  return Array.from({ length: rackCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Vertical cable manager sidecars, shared between adjacent racks.
 * T-501 Coded Note 2: one sidecar per side of a rack run; N racks in a row
 * share N+1 sidecars (mounted on both faces of the run), not 2×N -- a
 * sidecar between rack 1 and rack 2 serves both.
 *
 * @param {number} rackCount
 * @returns {number} 0 if no racks (existing/no new scope for this TR)
 */
export function sidecarCount(rackCount) {
  return rackCount > 0 ? rackCount + 1 : 0;
}

/**
 * Fiber cassette count for ONE core (Core-A or Core-B), from T-501 Coded
 * Note 3's stated strand counts -- NOT a fixed "12 cassettes" figure.
 * "BASIS OF DESIGN IS LEVITON OPT-X UHDX WITH (12) CASSETTES" describes the
 * unit's slot CAPACITY, not how many are populated; how many are actually
 * needed is a ceiling-division of required strands over per-cassette
 * capacity, same as the user's own worked example: 24 strands / 12 per
 * cassette = 2 cassettes minimum, not "12 cassettes" flatly assumed.
 *
 * ISP: 24-strand OM4 + 12-strand OS1/OS2 per core = 36 strands -> 3 cassettes.
 * OSP: 24-strand OS2 per core only = 24 strands -> 2 cassettes.
 * (T-501 itself says "OS1" for the singlemode strand count; T-001 and T-601
 * both say "OS2" for the equivalent spec -- likely a typo on T-501, flagged
 * here rather than silently resolved. Strand COUNT is identical either way
 * (12), so this cassette-count math is unaffected regardless of which is
 * correct; only the actual cable-part-number spec would need the real answer.)
 *
 * @param {'ISP'|'OSP'} plantType
 * @param {number} strandsPerCassette  Leviton HDX Enterprise MTP cassette
 *   capacity (default 12, per Coded Note 3's own cassette-count language)
 * @returns {number} cassettes needed for this one core
 */
export function cassetteCountPerCore(plantType, strandsPerCassette = 12) {
  const totalStrands = plantType === 'ISP' ? 24 + 12 : 24;
  return Math.ceil(totalStrands / strandsPerCassette);
}

/**
 * Total fiber cassettes for a TR's fiber interface -- both cores (Core-A and
 * Core-B terminate on opposite sides of the rack per Coded Note 3, but each
 * still needs its own cassette count; this sums both, not counting each core
 * only once).
 *
 * @param {'ISP'|'OSP'} plantType  same for both cores at one TR (a TR's
 *   backbone is either ISP or OSP, not mixed)
 * @returns {number}
 */
export function totalCassetteCount(plantType) {
  return cassetteCountPerCore(plantType) * 2; // Core-A + Core-B
}

export default { distributePatchPanels, sidecarCount, cassetteCountPerCore, totalCassetteCount };
