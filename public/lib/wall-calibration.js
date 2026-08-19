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

function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

function roundColor(rgb) {
  // stroke_rgb from geometry.js is 0..1 floats for setStrokeRGBColor, or
  // already 0..255 for setStrokeGray/CMYK (see extractSubpaths). Normalize
  // both onto a 0..255 scale, rounded, so visually-identical colors group
  // together regardless of which PDF operator set them.
  const to255 = (v) => (v <= 1 ? v * 255 : v);
  return rgb.map((v) => Math.round(to255(v)));
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
 * @param {Array<{pageId, scores: Array}>} perPage  output of scorePage per page, tagged with pageId
 * @returns {Array<{color, width, score, pagesAgreeing}>}
 */
export function aggregateScores(perPage) {
  const totals = new Map();
  for (const { scores } of perPage) {
    for (const s of scores) {
      const k = keyOf(s.color, s.width);
      const t = totals.get(k) ?? { color: s.color, width: s.width, score: 0, pagesAgreeing: 0 };
      t.score += s.score;
      totals.set(k, t);
    }
  }
  for (const { scores } of perPage) {
    if (!scores.length) continue;
    const top = scores[0];
    const k = keyOf(top.color, top.width);
    if (totals.has(k)) totals.get(k).pagesAgreeing++;
  }
  return [...totals.values()].sort((a, b) => b.score - a.score);
}

/**
 * Apply a chosen (color,width) signature to one page's stroke geometry and
 * split it into walls (long orthogonal runs) vs. door candidates (short
 * diagonal segments — door swing leaves), same classification the wall
 * signature itself was scored by, just without discarding the diagonals.
 *
 * @param {Array} strokeSubpaths
 * @param {Object} page
 * @param {{color:number[], width:number}} signature
 * @returns {Promise<{walls: Array<[x1,y1,x2,y2]>, doors: Array<{x,y}>}>}
 */
export async function classifyGeometry(strokeSubpaths, page, signature) {
  const groups = segmentsByKey(strokeSubpaths);
  const key = keyOf(signature.color, signature.width);
  const match = groups.get(key);
  const walls = [], doors = [];
  if (!match) return { walls, doors };

  const boxes = await textBoxes(page);
  for (const [x1, y1, x2, y2] of match.segments) {
    const dx = x2 - x1, dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 2) continue;
    const bx0 = Math.min(x1, x2), bx1 = Math.max(x1, x2);
    const by0 = Math.min(y1, y2), by1 = Math.max(y1, y2);
    if (nearText(boxes, bx0, by0, bx1, by1)) continue;
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90;
    const orthogonal = angle < WALL_ANGLE_TOL || angle > 90 - WALL_ANGLE_TOL;
    if (orthogonal && length > WALL_MIN_LEN) {
      walls.push([x1, y1, x2, y2]);
    } else if (!orthogonal && length > DOOR_MIN_LEN && length < DOOR_MAX_LEN) {
      doors.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    }
  }
  return { walls, doors };
}
