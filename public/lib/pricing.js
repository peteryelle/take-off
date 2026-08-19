// public/lib/pricing.js
// ─────────────────────────────────────────────────────────────────
// Pure material pricing layer. Joins an aggregated BOM (public/lib/bom.js
// aggregateBom() output) against a project's parts catalog by part_number.
// No DB, no DOM — offline-testable, same shape as bom.js.
//
// MATERIAL ONLY. Labor costing (rate config, labor_tasks, hour rollups) is
// a separate, not-yet-built layer — totals here are material cost/sale
// only and should be labeled as such wherever displayed.
//
// A component line with no part_number, or a part_number not present (or
// inactive) in the supplied catalog, is NOT priced at $0 — it's flagged
// as unresolved so a human catches it. This is the same brittleness-
// triggers-the-human reflex used everywhere else in this pipeline:
// silently pricing an unresolved line at $0 would understate a quote
// without anyone noticing.
//
// catalogParts: array of rows shaped like the parts_priced view —
//   { part_number, cost_unit, sale_unit, manufacturer, description, unit, active }
// Sale price is whatever the catalog computed (cost_unit / (1 - margin) as
// of read time) — this module doesn't know or care about margin, it just
// consumes cost_unit/sale_unit as given, so pricing always reflects the
// catalog's CURRENT margin unless the caller passes a locked/snapshotted
// catalog set instead.
// ─────────────────────────────────────────────────────────────────

export function priceBom(bom, catalogParts) {
  const byNumber = new Map();
  for (const p of catalogParts || []) {
    if (p && p.part_number) byNumber.set(String(p.part_number).trim(), p);
  }

  let cost_total = 0, sale_total = 0;
  const components = [];
  const unresolved  = [];

  for (const c of (bom && bom.components) || []) {
    const pn    = c.part_number ? String(c.part_number).trim() : null;
    const match = pn ? byNumber.get(pn) : null;

    if (!pn || !match || match.active === false) {
      const reason = !pn ? 'no_part_number' : (!match ? 'not_in_catalog' : 'inactive');
      unresolved.push({
        manufacturer: c.manufacturer || '',
        part_name:    c.part_name    || '',
        model:        c.model        || '',
        device_name:  c.device_name  || '',
        part_number:  pn,
        qty:          c.qty,
        per_run_ft:   c.per_run_ft,
        reason,
      });
      components.push({ ...c, cost_unit: null, sale_unit: null, line_cost: null, line_sale: null, priced: false });
      continue;
    }

    const cost_unit = Number(match.cost_unit);
    const sale_unit = Number(match.sale_unit);
    const qty       = Number(c.qty) || 0;
    const line_cost = Number.isFinite(cost_unit) ? Math.round(cost_unit * qty * 100) / 100 : null;
    const line_sale = Number.isFinite(sale_unit) ? Math.round(sale_unit * qty * 100) / 100 : null;

    if (line_cost != null) cost_total += line_cost;
    if (line_sale != null) sale_total += line_sale;

    components.push({
      ...c,
      cost_unit: Number.isFinite(cost_unit) ? cost_unit : null,
      sale_unit: Number.isFinite(sale_unit) ? sale_unit : null,
      line_cost, line_sale,
      priced: true,
    });
  }

  return {
    components,
    unresolved,
    totals: {
      cost_total:   Math.round(cost_total * 100) / 100,
      sale_total:   Math.round(sale_total * 100) / 100,
      margin_total: Math.round((sale_total - cost_total) * 100) / 100,
    },
  };
}
