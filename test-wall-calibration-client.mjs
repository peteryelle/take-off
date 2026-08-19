// test-wall-calibration-client.mjs
// Tests runWallCalibration/persistAllPageGeometry's actual logic against the
// real 7-page VA drawing set, with fetch mocked to capture what WOULD be
// sent rather than actually sending it (no live Netlify/Supabase from this
// environment). Verifies everything up to the network boundary: extraction,
// scoring, aggregation, POST body construction.
import { createRequire } from "module";
import { existsSync, readFileSync } from "node:fs";
import { runWallCalibration, persistAllPageGeometry } from "./public/lib/wall-calibration-client.js";

const require = createRequire(import.meta.url);
const PDF_PATH = "/mnt/user-data/uploads/T1_1-BLDG-01-ZONE-A-F.pdf";

function loadPdfjs() {
  try { return require("pdfjs-dist/legacy/build/pdf.js"); } catch { return null; }
}
const pdfjsLib = loadPdfjs();
if (!pdfjsLib || !pdfjsLib.OPS || !existsSync(PDF_PATH)) {
  console.log("SKIP — pdfjs-dist or the source PDF not present in this environment");
  process.exit(0);
}

let fails = 0;
function check(label, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fails++;
}

// Mock fetch: record every call, return a plausible response instead of
// hitting the network. Mirrors what pass-wall-calibrate.js / pass-wall-
// geometry.js actually return, based on their real implementation.
const calls = [];
global.fetch = async (url, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method: opts?.method, body });
  if (url.includes("pass-wall-calibrate")) {
    return {
      ok: true,
      json: async () => ({
        id: 1, project_id: body.project_id, status: "suggested",
        stroke_color: body.candidates[0].color, stroke_width: body.candidates[0].width,
        score: body.candidates[0].score, candidates: body.candidates, candidate_idx: 0,
      }),
    };
  }
  if (url.includes("pass-wall-geometry")) {
    return { ok: true, json: async () => ({ id: 1, ...body }) };
  }
  return { ok: false, status: 404, text: async () => "not mocked" };
};

const data = new Uint8Array(readFileSync(PDF_PATH));
const doc = await pdfjsLib.getDocument({ data }).promise;
const OPS = pdfjsLib.OPS;

const pageMap = { 1: "T1.1.A", 2: "T1.1.B", 4: "T1.1.C", 5: "T1.1.D", 6: "T1.1.E1", 7: "T1.1.E2", 8: "T1.1.F" };
const pages = [];
for (const [idxStr, name] of Object.entries(pageMap)) {
  const pdfPage = await doc.getPage(Number(idxStr) + 1);
  pages.push({ pageNum: Number(idxStr) + 1, pageId: Number(idxStr) + 1, pdfPage, name });
}

console.log("=== runWallCalibration ===");
const calibResult = await runWallCalibration({ apiBase: "https://fake.test", projectId: 42, pages, OPS });
check("returns the mocked wall_calibrations row", calibResult.status === "suggested");
check("POSTed to pass-wall-calibrate exactly once", calls.filter((c) => c.url.includes("pass-wall-calibrate")).length === 1);

const calibCall = calls.find((c) => c.url.includes("pass-wall-calibrate"));
check("POST body has project_id", calibCall.body.project_id === 42);
check("POST body candidates is a non-empty ranked array", Array.isArray(calibCall.body.candidates) && calibCall.body.candidates.length > 0);
check("winning candidate is the known-correct wall signature (gray ~119, width 0.36)",
  calibCall.body.candidates[0].color[0] === 119 && Math.abs(calibCall.body.candidates[0].width - 0.36) < 0.01);
check("pages_evaluated matches the page count", calibCall.body.pages_evaluated === 7);
check("pages_agreeing is 6 (matches the known per-page result — T1.1.C mispicks locally)", calibCall.body.pages_agreeing === 6);

console.log("\n=== persistAllPageGeometry ===");
calls.length = 0; // reset call log
const signature = { color: calibCall.body.candidates[0].color, width: calibCall.body.candidates[0].width };
const geomResults = await persistAllPageGeometry({ apiBase: "https://fake.test", projectId: 42, pages, OPS, signature });

check("returns one result per page", geomResults.length === 7);
check("all 7 pages persisted successfully (mocked)", geomResults.every((r) => r.ok));
check("POSTed to pass-wall-geometry exactly 7 times", calls.filter((c) => c.url.includes("pass-wall-geometry")).length === 7);
check("every page found a non-trivial wall count", geomResults.every((r) => r.wallCount > 500));

const t1cResult = geomResults.find((r) => pageMap[r.pageNum - 1] === "T1.1.C");
console.log(`\nT1.1.C specifically: ${t1cResult?.wallCount} walls, ${t1cResult?.doorCount} doors`);
check("T1.1.C — the page that mispicks its OWN signature locally — still gets correctly classified walls when given the aggregate winner explicitly (this is the whole point of aggregate calibration)",
  t1cResult && t1cResult.wallCount > 500);

console.log(fails === 0 ? "\nALL PASS — wall-calibration-client.js reproduces the validated pipeline end to end (up to the network boundary)" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
