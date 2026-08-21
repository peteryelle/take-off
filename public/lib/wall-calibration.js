// public/lib/wall-calibration.js
//
// Wall/door signature scoring and classification, extracted from a page's
// stroke geometry (see geometry.js:extractStrokeSubpaths). Direct port of a
// Python/PyMuPDF prototype validated against real VA CAD-export PDFs earlier
// in this project — see the per-page scoring numbers in scoreCandidates's
// test file for the known-correct reference values this was checked against.
//
// Three things this module does, matching the proven approach exactly:
//   1. Group stroke subpaths by (color, width) — the signature a firm's CAD
//      export uses consistently for walls vs. everything else on the sheet.
//   2. Score each group by how many long, orthogonal, non-text-adjacent
//      segments it contains — walls are long straight runs; scoring this way
//      distinguishes them from door-leaf diagonals, label-box borders, and
//      furniture/equipment line work without knowing the color in advance.
//   3. Aggregate scores across every page in a project before picking a
//      winner — a single unusual sheet (dense casework, atypical content)
//      can out-score walls on ITS OWN page while still losing the aggregate
//      vote once every other page's agreement is counted. This is the fix
//      for the real failure mode found on this project's own test set: a
//      per-page-only scorer picked wrong on 1 of 7 real sheets; the
//      aggregate got 7/7.

const MIN_GROUP_SIZE = 100;     // groups with fewer segments aren't a real signature
const WALL_MIN_LEN = 15;        // px; below this, treat as noise/tick marks
const WALL_ANGLE_TOL = 3;       // degrees from 0/90 to still count as "orthogonal"
const DOOR_MIN_LEN = 10;
const DOOR_MAX_LEN = 60;
const TEXT_PAD = 3;             // px; how close a segment can be to a text box before we discard it as label/leader-line noise
// Per-channel RGB distance under which two (color,width) candidates are
// treated as the SAME wall signature rather than competitors. Exists because
// a single real wall convention can render as two near-identical grays
// across a drawing set — e.g. (186,186,186) vs (119,119,119), same width —
// from anti-aliasing or a CAD export quirk, which otherwise splits one
// clear signal into two candidates that fight each other in aggregateScores
// and can make a decisive win look like an ambiguous tie (this is exactly
// what happened on project 18: winner beat runner-up by only 12.2%, just
// under the 15% auto-accept margin in multi-page.html, and the two
// candidates were (186,186,186) and (119,119,119), both width 0.36 — almost
// certainly one real signature, not two). That pair's actual per-channel
// gap is 67 — the tolerance has to clear that with some margin, or it
// doesn't catch the one real case it exists for. 70 is a starting number,
// not a derived one — same situation as the 15% margin: no real dataset to
// tune it against yet, picked to clear the project-18 gap (67) without
// merging genuinely distinct pen colors like black vs. red (gap of 255 on
// at least one channel).
const COLOR_CLUSTER_TOLERANCE = 70;

function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

function roundColor(rgb) {
  // stroke_rgb from geometry.js is 0..1 floats for setStrokeRGBColor, or
  // already 0..255 for setStrokeGray/CMYK (see extractSubpaths). Normalize
  // both onto a 0..255 scale, rounded, so visually-identical colors group
  // together regardless of which PDF operator set them.
  const to255 = (v) => (v <= 1 ? v * 255 : v);
  return rgb.map((v) => Math.round(to255(v)));
}

// True if two colors are within COLOR_CLUSTER_TOLERANCE on every channel —
// used both to cluster candidates before aggregating (aggregateScores) and
// to match a page's actual stroke color against a confirmed signature that
// may represent a cluster, not one exact RGB triple (classifyGeometry).
function colorsClose(a, b, tol = COLOR_CLUSTER_TOLERANCE) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

function keyOf(color, width) {
  return `${roundColor(color).join(",")}|${Math.round(width * 100) / 100}`;
}

/**
 * Build (color,width) -> list of individual line segments, from stroke
 * subpaths. A subpath can carry several connected points (multiple lineTo
 * calls chained after one moveTo) — each consecutive pair is one segment,
 * matching PyMuPDF's atomic 'l' items that the original Python version
 * scored directly.
 */
function segmentsByKey(strokeSubpaths) {
  const groups = new Map();
  for (const sp of strokeSubpaths) {
    const key = keyOf(sp.stroke_rgb, sp.line_width);
    let list = groups.get(key);
    if (!list) { list = { color: roundColor(sp.stroke_rgb), width: Math.round(sp.line_width * 100) / 100, segments: [] }; groups.set(key, list); }
    const pts = sp.points;
    for (let i = 0; i < pts.length - 1; i++) {
      list.segments.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
    }
  }
  return groups;
}

/**
 * Text bounding boxes for the near-text exclusion filter — same purpose as
 * the Python version's near_text() check against page.get_text("words"):
 * strip out label-box borders, leader lines, and room-name underlines that
 * would otherwise masquerade as short wall/door segments.
 */
async function textBoxes(page) {
  const content = await page.getTextContent();
  const boxes = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const w = item.width ?? Math.hypot(a, b) * item.str.length * 0.5;
    const h = item.height ?? (Math.hypot(c, d) || 10);
    boxes.push({ x0: e, y0: f - h, x1: e + w, y1: f });
  }
  return boxes;
}

function nearText(boxes, x0, y0, x1, y1, pad = TEXT_PAD) {
  for (const b of boxes) {
    if (x0 <= b.x1 + pad && x1 >= b.x0 - pad && y0 <= b.y1 + pad && y1 >= b.y0 - pad) return true;
  }
  return false;
}

/**
 * Score one page's stroke geometry: for every (color,width) group with
 * enough volume to be a real signature, count long/orthogonal/non-text
 * segments. Returns a ranked list, highest score first — this page's own
 * opinion, before any cross-page aggregation.
 *
 * @param {Array} strokeSubpaths  from extractStrokeSubpaths(page, OPS)
 * @param {Object} page           the same pdf.js page (for getTextContent)
 * @returns {Promise<Array<{color:number[], width:number, score:number, segmentCount:number}>>}
 */
export async function scorePage(strokeSubpaths, page) {
  const groups = segmentsByKey(strokeSubpaths);
  const boxes = await textBoxes(page);
  const scored = [];

  for (const { color, width, segments } of groups.values()) {
    if (segments.length < MIN_GROUP_SIZE) continue;
    let longOrtho = 0;
    for (const [x1, y1, x2, y2] of segments) {
      const dx = x2 - x1, dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length < WALL_MIN_LEN) continue;
      const bx0 = Math.min(x1, x2), bx1 = Math.max(x1, x2);
      const by0 = Math.min(y1, y2), by1 = Math.max(y1, y2);
      if (nearText(boxes, bx0, by0, bx1, by1)) continue;
      const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90;
      if (angle < WALL_ANGLE_TOL || angle > 90 - WALL_ANGLE_TOL) longOrtho++;
    }
    scored.push({ color, width, score: longOrtho, segmentCount: segments.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Aggregate per-page scores across every page in a project into one ranked
 * candidate list. This is the fix for the single-bad-sheet failure mode —
 * see the module header. Returns the same shape as scorePage's output, plus
 * pagesAgreeing (how many pages independently picked this signature as
 * their own #1 — informational, shown on the review card, NOT used to
 * decide the winner; the aggregate SUM decides the winner).
 *
 * Candidates within COLOR_CLUSTER_TOLERANCE of each other (same width) are
 * merged into one cluster BEFORE summing — otherwise one real wall
 * convention rendered as two near-identical grays across a drawing set
 * splits its own vote and can lose to an unrelated third candidate, or look
 * like a narrow/ambiguous win against a "runner-up" that was actually the
 * same signature. See COLOR_CLUSTER_TOLERANCE's comment for the project-18
 * case this fixes. Clustering is greedy: candidates are processed
 * highest-individual-score first, each either joining the nearest existing
 * cluster (same width, within tolerance) or starting a new one — so the
 * cluster's reported color is always its highest-scoring member's exact
 * color, which is also what gets persisted as the confirmed signature.
 *
 * @param {Array<{pageId, scores: Array}>} perPage  output of scorePage per page, tagged with pageId
 * @returns {Array<{color, width, score, pagesAgreeing}>}
 */
export function aggregateScores(perPage) {
  // Flatten every page's candidates into one list, summing raw per-key
  // scores first (same as before) so we cluster on genuinely-observed
  // (color,width) pairs rather than re-deriving them some other way.
  const rawTotals = new Map();   // key -> { color, width, score }
  for (const { scores } of perPage) {
    for (const s of scores) {
      const k = keyOf(s.color, s.width);
      const t = rawTotals.get(k) ?? { color: s.color, width: s.width, score: 0 };
      t.score += s.score;
      rawTotals.set(k, t);
    }
  }

  // Greedy clustering, highest raw score first, so each cluster's
  // representative color is its strongest member.
  const ordered = [...rawTotals.values()].sort((a, b) => b.score - a.score);
  const clusters = [];   // { color, width, score, memberKeys: Set<string> }
  for (const cand of ordered) {
    const home = clusters.find(c => c.width === cand.width && colorsClose(c.color, cand.color));
    if (home) {
      home.score += cand.score;
      home.memberKeys.add(keyOf(cand.color, cand.width));
    } else {
      clusters.push({ color: cand.color, width: cand.width, score: cand.score, memberKeys: new Set([keyOf(cand.color, cand.width)]) });
    }
  }

  // pagesAgreeing: for each page's own top pick, find which cluster its
  // exact (color,width) landed in, via the memberKeys built above — a page
  // whose own top pick was the "runner-up" gray now correctly counts toward
  // the SAME cluster as a page whose top pick was the winning gray.
  const keyToCluster = new Map();
  for (const c of clusters) for (const k of c.memberKeys) keyToCluster.set(k, c);
  for (const { scores } of perPage) {
    if (!scores.length) continue;
    const top = scores[0];
    const c = keyToCluster.get(keyOf(top.color, top.width));
    if (c) c.pagesAgreeing = (c.pagesAgreeing ?? 0) + 1;
  }

  return clusters
    .map(({ color, width, score, pagesAgreeing }) => ({ color, width, score, pagesAgreeing: pagesAgreeing ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Apply a chosen (color,width) signature to one page's stroke geometry and
 * split it into walls (long orthogonal runs) vs. door candidates (short
 * diagonal segments — door swing leaves), same classification the wall
 * signature itself was scored by, just without discarding the diagonals.
 *
 * Output is Y-FLIPPED to match the app's established page-point convention
 * (top-left origin, y-down) — the SAME convention contentFrame.norm() already
 * flips into for symbol/text coordinates, and the convention device/demarc
 * positions arrive in from pass-batch.js (normalized coords × page dimensions,
 * already y-down since they were normalized via contentFrame in the first
 * place). extractStrokeSubpaths itself deliberately stays in raw PDF space
 * (y-up), matching extractFilledSubpaths's existing behavior — this function
 * is the boundary where that raw space becomes the app's working convention,
 * so every caller downstream (wall-aware-path.js, pass-batch.js) can treat
 * walls/doors and device/demarc positions as being in the same space without
 * each one re-deriving the flip itself.
 *
 * @param {Array} strokeSubpaths
 * @param {Object} page
 * @param {{color:number[], width:number}} signature
 * @returns {Promise<{walls: Array<[x1,y1,x2,y2]>, doors: Array<{x,y}>}>}
 */
export async function classifyGeometry(strokeSubpaths, page, signature) {
  const groups = segmentsByKey(strokeSubpaths);
  // Fuzzy match, not exact key lookup: the confirmed signature is one
  // representative color (a cluster's strongest member, from
  // aggregateScores), but THIS page's own walls might render in a nearby-
  // but-not-identical gray from the same cluster (anti-aliasing, CAD export
  // quirk — see COLOR_CLUSTER_TOLERANCE's comment). An exact match here
  // would silently classify such a page as zero walls instead of erroring,
  // which is worse than the vote-splitting bug this was meant to fix.
  // Segments from every matching group are merged before classification.
  const matchingGroups = [...groups.values()].filter(
    g => g.width === signature.width && colorsClose(g.color, signature.color)
  );
  const walls = [], doors = [];
  if (!matchingGroups.length) return { walls, doors };
  const segments = matchingGroups.flatMap(g => g.segments);

  const vp = page.getViewport({ scale: 1 });
  const flipY = (y) => vp.height - y;

  const boxes = await textBoxes(page);
  for (const [x1, y1, x2, y2] of segments) {
    const dx = x2 - x1, dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 2) continue;
    const bx0 = Math.min(x1, x2), bx1 = Math.max(x1, x2);
    const by0 = Math.min(y1, y2), by1 = Math.max(y1, y2);
    if (nearText(boxes, bx0, by0, bx1, by1)) continue;
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90;
    const orthogonal = angle < WALL_ANGLE_TOL || angle > 90 - WALL_ANGLE_TOL;
    if (orthogonal && length > WALL_MIN_LEN) {
      walls.push([x1, flipY(y1), x2, flipY(y2)]);
    } else if (!orthogonal && length > DOOR_MIN_LEN && length < DOOR_MAX_LEN) {
      doors.push({ x: (x1 + x2) / 2, y: flipY((y1 + y2) / 2) });
    }
  }
  return { walls, doors };
}
