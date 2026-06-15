// netlify/functions/pass-bom.js
// Build BOM from device_instances on a page
// Matches instances → assembly_templates → expands parts → writes bom_items
//
// POST /api/pass-bom
// Body: { project_id, page_id }
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";

import { requireOrg, assertProjectInOrg, assertPageInOrg } from "./utils/auth.js";
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, page_id } = body;
  if (!project_id || !page_id) return err("project_id and page_id required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId))) return err("Project not found in your organization", 404);

  // ── Load device instances + assembly templates ─────────────────
  const [
    { data: instances, error: instErr },
    { data: templates, error: tmplErr }
  ] = await Promise.all([
    supabase.from("device_instances")
      .select("*, device_types(name, legend_id)")
      .eq("page_id", page_id),
    supabase.from("assembly_templates")
      .select("*, assembly_parts(*)")
      .eq("project_id", project_id)
  ]);

  if (instErr) return err(`Instance load error: ${instErr.message}`, 500);
  if (tmplErr) return err(`Template load error: ${tmplErr.message}`, 500);

  if (!instances?.length) return ok({ bom: [], warnings: ["No device instances found for this page"] });

  // ── Build template index: sorted label key → template ─────────
  // trigger_labels are sorted at save time so matching is order-independent
  const tmplIndex = {};
  for (const t of (templates ?? [])) {
    const key = [...t.trigger_labels].sort().join("|");
    tmplIndex[key] = t;
  }

  // ── Expand each device instance → BOM rows ────────────────────
  const bomRows  = [];
  const unmatched = [];

  for (const inst of instances) {
    // Build match key from this instance's labels
    const instLabels = [
      ...(inst.data_ports  ?? []),
      ...(inst.voice_ports ?? []),
      ...(inst.node_labels ?? [])
    ].sort();
    const instKey = instLabels.join("|");

    const template = tmplIndex[instKey];
    if (!template) {
      unmatched.push({ instance_id: inst.id, labels: instLabels, reason: "No assembly template found" });
      continue;
    }

    const runFt         = inst.total_ft     ?? 0;
    const portData      = inst.port_count_data  ?? 1;
    const portVoice     = inst.port_count_voice ?? 1;
    const cableRuns     = template.cable_runs   ?? 1;

    for (const part of (template.assembly_parts ?? [])) {
      // Resolve quantity
      const rawQty = (part.qty_fixed           ?? 0)
                   + (part.qty_per_data_port   ?? 0) * portData
                   + (part.qty_per_voice_port  ?? 0) * portVoice
                   + (part.qty_per_run_ft      ?? 0) * runFt * cableRuns * (part.waste_factor ?? 1);

      if (rawQty <= 0) continue;

      const qtyRounded = part.box_size
        ? Math.ceil(rawQty / part.box_size) * part.box_size
        : null;

      bomRows.push({
        project_id,
        demarc_id:          inst.demarc_id,
        assembly_id:        template.id,
        device_instance_id: inst.id,
        part_number:        part.part_number  ?? null,
        description:        part.description,
        qty:                parseFloat(rawQty.toFixed(2)),
        qty_rounded:        qtyRounded,
        unit:               part.unit,
        box_size:           part.box_size ?? null
      });
    }
  }

  // ── Write BOM rows ─────────────────────────────────────────────
  // Delete existing BOM for this page first (idempotent)
  await supabase.from("bom_items")
    .delete()
    .eq("project_id", project_id)
    .in("device_instance_id", instances.map(i => i.id));

  let inserted = [];
  if (bomRows.length) {
    const { data, error: bomErr } = await supabase
      .from("bom_items")
      .insert(bomRows)
      .select("id, demarc_id, description, qty, qty_rounded, unit");

    if (bomErr) return err(`BOM insert error: ${bomErr.message}`, 500);
    inserted = data ?? [];
  }

  // ── Rollup by demarc + part ────────────────────────────────────
  const rollup = {};  // "demarc_name|part_number|description" → totals
  for (const row of bomRows) {
    const demarc = row.demarc_id ?? "unassigned";
    const key    = `${demarc}|${row.part_number ?? ""}|${row.description}|${row.unit}`;
    if (!rollup[key]) {
      rollup[key] = {
        demarc_id:   row.demarc_id,
        part_number: row.part_number,
        description: row.description,
        unit:        row.unit,
        box_size:    row.box_size,
        total_qty:   0,
        device_count: 0
      };
    }
    rollup[key].total_qty    += row.qty;
    rollup[key].device_count += 1;
  }

  // Round totals at rollup level
  const rollupRows = Object.values(rollup).map(r => ({
    ...r,
    total_qty:   parseFloat(r.total_qty.toFixed(2)),
    boxes_needed: r.box_size ? Math.ceil(r.total_qty / r.box_size) : null
  }));

  const warnings = [];
  if (unmatched.length)
    warnings.push(`${unmatched.length} device instance(s) had no matching assembly template`);

  return ok({
    pass:          "bom",
    page_id,
    project_id,
    bom_rows:      inserted.length,
    rollup:        rollupRows,
    unmatched,
    warnings
  });
}

export const config = { path: "/api/pass-bom" };
