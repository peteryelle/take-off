// test-pass-discover.mjs
// Tests the deployed pass-discover function against VA Syracuse drawings
//
// Usage:
//   node test-pass-discover.mjs legend.jpg page3.jpg
//
// ─────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";

const BASE_URL   = "https://winquest-take-off.netlify.app";
const PROJECT_ID = 4;  // your test project

const [,, legendPath, floorplanPath] = process.argv;
if (!legendPath || !floorplanPath) {
  console.error("Usage: node test-pass-discover.mjs <legend.jpg> <floorplan.jpg>");
  process.exit(1);
}

function toB64(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) { console.error("Not found:", abs); process.exit(1); }
  return fs.readFileSync(abs).toString("base64");
}

const legendB64    = toB64(legendPath);
const floorplanB64 = toB64(floorplanPath);

console.log(`Legend:    ${legendPath} (${Math.round(legendB64.length/1024)} KB b64)`);
console.log(`Floorplan: ${floorplanPath} (${Math.round(floorplanB64.length/1024)} KB b64)`);
console.log(`\nCalling ${BASE_URL}/api/pass-discover (action: scan)…\n`);

const resp = await fetch(`${BASE_URL}/api/pass-discover`, {
  method:  "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action:              "scan",
    project_id:          PROJECT_ID,
    sample_images:       [floorplanB64],
    legend_images:       [legendB64],
    sample_page_numbers: [3],
    legend_page_numbers: [2]
  })
});

const data = await resp.json();

if (!resp.ok) {
  console.error("ERROR:", data.error);
  process.exit(1);
}

console.log(`✓ Session ID: ${data.session_id}`);
console.log(`✓ Clusters found: ${data.clusters_found}`);
console.log(`✓ Noise filtered: ${data.clusters_noise}`);
console.log(`  Summary: high=${data.summary.high} medium=${data.summary.medium} low=${data.summary.low}\n`);

console.log("══════════════════════════════════════════");
console.log("CLUSTERS FOR REVIEW");
console.log("══════════════════════════════════════════\n");

data.clusters.forEach(c => {
  const flag = c.match_confidence === "high" ? "✓" :
               c.match_confidence === "medium" ? "⚠" : "✗";
  console.log(`${flag} [${c.cluster_id}] ${c.legend_name ?? "NO MATCH"} (${c.match_confidence})`);
  console.log(`   Count:   ~${c.approximate_count}`);
  console.log(`   Anchors: [${c.nearby_text?.join(", ")}]`);
  console.log(`   Drawing: ${c.visual_description?.slice(0, 90)}`);
  console.log(`   Reason:  ${c.match_reason}`);
  console.log();
});

// Save full response
fs.writeFileSync("discover-result.json", JSON.stringify(data, null, 2));
console.log("Full response saved to discover-result.json");
console.log(`\nSession ${data.session_id} is now in Supabase → discovery_clusters`);
console.log("Check: supabase.com → Table Editor → discovery_clusters");
