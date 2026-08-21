// test-wall-calibration-clustering.mjs
// Synthetic (non-PDF) fixture test for the color-clustering fix added to
// aggregateScores/classifyGeometry — validates the fix directly against
// aggregateScores' own input/output shape and classifyGeometry's segment
// matching, without needing the real PDF fixtures test-wall-calibration.mjs
// and test-wall-calibration-client.mjs depend on (T1_1-BLDG-01-ZONE-A-F.pdf,
// not always present in every environment this runs in).
//
// Reproduces project 18's real numbers: winner (186,186,186)@0.36 scored
// 8837, runner-up (119,119,119)@0.36 scored 7873 — a 12.2% margin, just
// under the 15% auto-accept gate in multi-page.html. Both are the SAME
// real wall signature rendered as two near-identical grays; a third,
// genuinely distinct candidate ((0,0,0)@0.24, score 5706 in the real data)
// must NOT get pulled into the cluster.
import { aggregateScores, classifyGeometry } from "./public/lib/wall-calibration.js";

let fails = 0;
function check(label, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fails++;
}

// ── aggregateScores: clustering + pagesAgreeing ─────────────────────
// 9 synthetic pages, matching project 18's pages_evaluated=9/pages_agreeing=7.
// 7 pages split their own top pick between the two near-duplicate grays
// (mirrors why the real per-page top-pick would look "ambiguous" without
// clustering); 2 pages pick the genuinely distinct black.
const GRAY_A = [186, 186, 186];   // real project-18 winner
const GRAY_B = [119, 119, 119];   // real project-18 runner-up — same signature, different render
const BLACK  = [0, 0, 0];         // genuinely distinct — must not merge

const perPage = [
  { pageId: "p1", scores: [{ color: GRAY_A, width: 0.36, score: 1200 }, { color: BLACK, width: 0.24, score: 600 }] },
  { pageId: "p2", scores: [{ color: GRAY_B, width: 0.36, score: 1100 }, { color: BLACK, width: 0.24, score: 500 }] },
  { pageId: "p3", scores: [{ color: GRAY_A, width: 0.36, score: 900 },  { color: BLACK, width: 0.24, score: 700 }] },
  { pageId: "p4", scores: [{ color: GRAY_B, width: 0.36, score: 950 },  { color: BLACK, width: 0.24, score: 650 }] },
  { pageId: "p5", scores: [{ color: GRAY_A, width: 0.36, score: 1050 }, { color: BLACK, width: 0.24, score: 620 }] },
  { pageId: "p6", scores: [{ color: GRAY_B, width: 0.36, score: 980 },  { color: BLACK, width: 0.24, score: 580 }] },
  { pageId: "p7", scores: [{ color: GRAY_A, width: 0.36, score: 1000 }, { color: BLACK, width: 0.24, score: 610 }] },
  // These two pages' own top pick is the genuinely distinct black — should
  // NOT count toward the gray cluster's pagesAgreeing.
  { pageId: "p8", scores: [{ color: BLACK, width: 0.24, score: 900 },  { color: GRAY_A, width: 0.36, score: 400 }] },
  { pageId: "p9", scores: [{ color: BLACK, width: 0.24, score: 850 },  { color: GRAY_B, width: 0.36, score: 380 }] },
];

const aggregate = aggregateScores(perPage);
console.log("aggregate ranking:");
for (const a of aggregate) console.log(`  score=${a.score}  color=${a.color}  width=${a.width}  pagesAgreeing=${a.pagesAgreeing}`);

const winner = aggregate[0];
const expectedGrayTotal = 1200 + 1100 + 900 + 950 + 1050 + 980 + 1000 + 400 + 380; // 8960
const expectedBlackTotal = 600 + 500 + 700 + 650 + 620 + 580 + 610 + 900 + 850;    // 6010

check("winner is the merged gray cluster (not black)", winner.width === 0.36);
check("merged gray cluster's score is the SUM of both near-duplicate grays", winner.score === expectedGrayTotal);
check("black stays a separate, un-merged candidate", aggregate.some(c => c.width === 0.24 && c.score === expectedBlackTotal));
check("gray cluster's pagesAgreeing counts BOTH grays' own-top-pick pages (7)", winner.pagesAgreeing === 7);
check("black's pagesAgreeing is 2 (p8, p9 — their own top pick)",
  aggregate.find(c => c.width === 0.24)?.pagesAgreeing === 2);

// Sanity: with clustering, this now clears the 15% margin against black
// (6010), where without clustering GRAY_A alone (via the real project-18
// numbers, 8837 vs 7873) did not clear it against GRAY_B.
const runnerUp = aggregate[1];
const margin = winner.score / runnerUp.score;
check(`merged winner clears a 15% margin against the real runner-up (ratio ${margin.toFixed(3)})`, margin >= 1.15);

// ── classifyGeometry: fuzzy match against a page using the "other" gray ──
// A page's own exact stroke color is GRAY_B (119,119,119), but the
// CONFIRMED signature persisted from aggregateScores is GRAY_A's exact
// color (186,186,186) — the cluster's strongest member. Before this fix,
// classifyGeometry's exact-key lookup would find zero matching segments on
// this page and silently report zero walls. After the fix, fuzzy color
// matching (same COLOR_CLUSTER_TOLERANCE) should still find them.
const fakeStrokeSubpaths = [
  { stroke_rgb: GRAY_B, line_width: 0.36, points: [[0, 0], [100, 0]] },      // long horizontal wall segment
  { stroke_rgb: GRAY_B, line_width: 0.36, points: [[0, 0], [0, 100]] },      // long vertical wall segment
  { stroke_rgb: BLACK,  line_width: 0.24, points: [[0, 0], [50, 50]] },      // unrelated — must NOT be picked up
];
const fakePage = {
  getViewport: () => ({ width: 1000, height: 1000 }),
  getTextContent: async () => ({ items: [] }),
};
const { walls, doors } = await classifyGeometry(fakeStrokeSubpaths, fakePage, { color: GRAY_A, width: 0.36 });
check("classifyGeometry finds GRAY_B's segments when given GRAY_A as the confirmed signature (fuzzy match)", walls.length === 2);
check("classifyGeometry does NOT pull in the unrelated black segment", doors.length === 0 && walls.length === 2);

console.log(fails === 0 ? "\nALL PASS — color-clustering fix validated against project 18's real numbers" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
