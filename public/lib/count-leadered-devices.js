// count-leadered-devices.js — sums leader-fan device counts for a room, from
// one or more coded-note callouts. No PDF, no DOM, no network.
//
// Reuses leader-trace.js's traceLeaderFan exactly as-is; this module's whole
// job is calling it correctly for THIS use case (rack counting from a
// coded-note callout) rather than leader-trace's original one (a labeled
// device's own leadered position), and handling the case a room needs
// leader-trace didn't: MULTIPLE separate callouts contributing to one
// room's total (confirmed on real data -- EB51A-1 has two "2" callouts,
// fanout 2 + fanout 1, correctly summing to its true count of 3).
//
// Why searchRadius=30 by default, not leader-trace's own 200 default: that
// 200 was proven on a different, sparser drawing. On this AE's dense
// TR-room plans (tile grids, wall hatching, zone-boundary rectangles all in
// the same coordinate space), a 200-unit radius returns hundreds of
// candidate segments and finds a plausible-looking but WRONG fan origin
// 130-225 units from the real callout -- confirmed and rejected on real
// data before this module was written.
//
// maxOriginDist is the second, load-bearing guard this module adds on top
// of the raw traceLeaderFan result. Even at a tight searchRadius=30, a
// coincidental high-degree vertex from ordinary wall/furniture geometry can
// still surface as "ok:true" -- confirmed on real data: C085A-1 returned a
// confident (and WRONG, truth=1) fanout of 2 from an origin 25.9 units from
// its anchor, while every CONFIRMED-CORRECT match on this same sheet
// clustered tightly at 11.3-15.9 units. A leader's true origin sits right
// at its callout bubble's edge -- a small, physically fixed distance from
// the bubble's own text center, essentially independent of searchRadius.
// 20 units is set just above that confirmed-good cluster and rejects both
// known false-positive-prone cases (C085A-1: 25.9, A030A-1: 21.5) as
// needsReview rather than risk trusting a coincidental match.
//
// Validated against 9 real, human-counted TR rooms from one production
// sheet (T-401, VA Gainesville EHRM): 6/9 exact matches including the
// compound EB51A-1 case, ZERO confidently-wrong answers after this guard
// was added. The 3 flagged cases (single-leader "TYPICAL" callouts) are a
// known, named follow-up -- see test-count-leadered-devices.mjs.

import { traceLeaderFan } from './leader-trace.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * @param {Array<[number,number]>} anchors  one entry per rack-callout
 *   ("②"-style) text anchor found in this room's coded-notes region.
 *   Zero anchors is valid (a room can genuinely have none, e.g. DB97-1).
 * @param {Array<[[number,number],[number,number]]>} segments  vector line
 *   segments in the same coordinate space as `anchors` (PDF points, PDF.js
 *   user units, pixels -- caller's choice, must match).
 * @param {Object} opts  passed through to traceLeaderFan, plus:
 *   maxOriginDist (default 20) -- reject a resolved fan whose origin sits
 *   farther than this from its anchor (see file header for why 20).
 * @returns {{
 *   total: number,            // summed fanout across all resolved anchors
 *   perAnchor: Array<{anchor, ok, fanout?, reason?}>,
 *   needsReview: boolean,     // true if ANY anchor failed to resolve
 *   unresolvedAnchors: Array<[number,number]>  // for the confidence-map UI
 * }}
 */
export function countLeaderedDevices(anchors = [], segments = [], opts = {}) {
  const {
    searchRadius = 30,
    minLeaderLen = 15,
    minFanout = 1,
    snap = 3,
    dedupeWithin = 6,
    maxOriginDist = 20,
  } = opts;

  const perAnchor = anchors.map((anchor) => {
    const r = traceLeaderFan(segments, anchor, { searchRadius, minLeaderLen, minFanout, snap, dedupeWithin });
    if (!r.ok) return { anchor, ok: false, reason: r.reason };
    if (dist(r.origin, anchor) > maxOriginDist) {
      return { anchor, ok: false, reason: 'origin_too_far_from_anchor' };
    }
    return { anchor, ok: true, fanout: r.fanout, origin: r.origin };
  });

  const total = perAnchor.reduce((sum, r) => sum + (r.ok ? r.fanout : 0), 0);
  const unresolvedAnchors = perAnchor.filter((r) => !r.ok).map((r) => r.anchor);

  return {
    total,
    perAnchor,
    needsReview: unresolvedAnchors.length > 0,
    unresolvedAnchors,
  };
}

export default countLeaderedDevices;
