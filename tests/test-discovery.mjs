// test-discovery.mjs
// Symbol Discovery proof-of-concept test
//
// Usage:
//   node test-discovery.mjs <legend-image.jpg> <floorplan-image.jpg>
//
// Example:
//   node test-discovery.mjs ~/Desktop/legend.jpg ~/Desktop/floorplan.jpg
//
// Reads ANTHROPIC_API_KEY from .env.local automatically.
// ─────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

// ── Load .env.local ───────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error("ERROR: .env.local not found. Run from take-off directory.");
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

loadEnv();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Args ──────────────────────────────────────────────────────────
const [,, legendPath, floorplanPath] = process.argv;
if (!legendPath || !floorplanPath) {
  console.error("Usage: node test-discovery.mjs <legend.jpg> <floorplan.jpg>");
  process.exit(1);
}

function toBase64(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }
  return fs.readFileSync(abs).toString("base64");
}

const legendB64    = toBase64(legendPath);
const floorplanB64 = toBase64(floorplanPath);

console.log(`\nLegend:    ${legendPath} (${Math.round(legendB64.length / 1024)} KB b64)`);
console.log(`Floorplan: ${floorplanPath} (${Math.round(floorplanB64.length / 1024)} KB b64)`);

// ── PASS 1: Scan floor plan — find distinct repeating symbols ─────
console.log("\n════════════════════════════════════════");
console.log("PASS 1 — Floor plan symbol discovery");
console.log("════════════════════════════════════════");

const pass1Prompt = `This is a telecommunications floor plan drawing for a VA hospital building.

Your task: identify every distinct device symbol type that repeats on this drawing.

For each symbol type found:
1. Describe EXACTLY what it looks like as drawn — shape, fill, size, any internal marks, color
2. Note any text labels that consistently appear nearby (these become detection anchors)
3. Count approximately how many times it appears on this page
4. Note where it tends to appear (wall locations, open areas, corridors, ceiling grid, etc.)

Rules:
- Do NOT name the devices — only describe what you visually observe
- Do NOT include room labels, dimension text, grid letters/numbers, title block text, or keynote callout numbers
- Only include symbols that repeat at least 3 times
- Be precise enough that someone could find this exact symbol on a busy drawing

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "symbols_found": [
    {
      "cluster_id": "A",
      "visual_description": "precise description of shape, fill, size, marks exactly as seen on drawing",
      "nearby_text": ["DD2", "DV1"],
      "approximate_count": 45,
      "location_pattern": "appears at wall locations, always paired with text labels above"
    }
  ]
}`;

const pass1Response = await anthropic.messages.create({
  model:      "claude-sonnet-4-5",
  max_tokens: 2000,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: floorplanB64 } },
      { type: "text",  text: pass1Prompt }
    ]
  }]
});

const pass1Raw = pass1Response.content[0].text;
console.log("\nRaw response:\n", pass1Raw);

let clusters;
try {
  clusters = JSON.parse(pass1Raw.replace(/```json|```/g, "").trim());
} catch(e) {
  console.error("JSON parse failed:", e.message);
  process.exit(1);
}

console.log(`\n✓ Found ${clusters.symbols_found.length} distinct symbol types`);
clusters.symbols_found.forEach(s => {
  console.log(`  [${s.cluster_id}] ~${s.approximate_count}x | anchors: [${s.nearby_text?.join(", ")}] | ${s.visual_description.slice(0,80)}...`);
});

// ── PASS 2: Reconcile clusters against legend ─────────────────────
console.log("\n════════════════════════════════════════");
console.log("PASS 2 — Legend reconciliation");
console.log("════════════════════════════════════════");

const clusterSummary = clusters.symbols_found.map(s =>
  `Cluster ${s.cluster_id}: ${s.visual_description} | nearby text: [${s.nearby_text?.join(", ")}]`
).join("\n");

const pass2Prompt = `I have scanned a telecommunications floor plan and found these distinct symbol types:

${clusterSummary}

This is the legend page for the same drawing set. For each cluster listed above, find the legend entry that best matches it.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "matches": [
    {
      "cluster_id": "A",
      "legend_name": "exact name from legend",
      "legend_description": "description as written in legend",
      "confidence": "high|medium|low",
      "confidence_reason": "brief explanation of why this match was made or why confidence is lower"
    }
  ]
}

If a cluster does not match any legend entry, set legend_name to null and confidence to "low".`;

const pass2Response = await anthropic.messages.create({
  model:      "claude-sonnet-4-5",
  max_tokens: 2000,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: legendB64 } },
      { type: "text",  text: pass2Prompt }
    ]
  }]
});

const pass2Raw = pass2Response.content[0].text;
console.log("\nRaw response:\n", pass2Raw);

let matches;
try {
  matches = JSON.parse(pass2Raw.replace(/```json|```/g, "").trim());
} catch(e) {
  console.error("JSON parse failed:", e.message);
  process.exit(1);
}

// ── Combined results ──────────────────────────────────────────────
console.log("\n════════════════════════════════════════");
console.log("COMBINED RESULTS");
console.log("════════════════════════════════════════\n");

const matchMap = {};
matches.matches.forEach(m => matchMap[m.cluster_id] = m);

clusters.symbols_found.forEach(s => {
  const m = matchMap[s.cluster_id] ?? {};
  const conf  = m.confidence ?? "—";
  const name  = m.legend_name ?? "NO MATCH";
  const flag  = conf === "high" ? "✓" : conf === "medium" ? "⚠" : "✗";
  
  console.log(`${flag} [${s.cluster_id}] ${name} (${conf})`);
  console.log(`     Count: ~${s.approximate_count} | Anchors: [${s.nearby_text?.join(", ")}]`);
  console.log(`     Drawing: ${s.visual_description.slice(0, 100)}`);
  if (m.confidence_reason) console.log(`     Reason: ${m.confidence_reason}`);
  console.log();
});

// ── Save full output ──────────────────────────────────────────────
const output = {
  pass1: clusters,
  pass2: matches,
  combined: clusters.symbols_found.map(s => ({
    ...s,
    ...(matchMap[s.cluster_id] ?? {})
  }))
};

fs.writeFileSync("discovery-test-output.json", JSON.stringify(output, null, 2));
console.log("Full output saved to: discovery-test-output.json");
