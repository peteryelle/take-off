// netlify/functions/wf8-bom.js
// WF8 BOM — output only. Free (no model calls).
//
// GET  /api/wf/wf8/bom?project_id=9
//   -> { project, model, revisions, snapshots:[{id,kind,label,created_at,stats}], reference, change_orders }
// POST /api/wf/wf8/bom  { action, project_id, ... }
//   generate   { label? }          save a locked 'generated' snapshot of the current model -> { snapshot, model }
//   snapshot   { snapshot_id }     full snapshot (to rebuild its workbook)
//   pin        { snapshot_id }     make it the reference (a new 'reference' snapshot copying it)
//   co_preview {}                  current model vs the reference -> lines with causes
//   create_co  { number? }         save a 'co' snapshot + change order + lines
//   co         { change_order_id } a change order and its lines
//   settings   { material_margin?, labor_rate?, co_pricing_basis? }
//   catalogs   {}                   the org's parts catalogs      set_catalog { catalog_id }
//   save_part  { part }             add / update a part in the project's catalog (created on first use)
//   delete_part{ part_number }
//   save_line  { item_key, item_label?, part_number, qty, waste?, note? }   delete_line { item_key, part_number }
//   import     { parts, assemblies, replace_items }   parts upserted; items in replace_items get exactly the given lines
// Snapshots are immutable (database trigger). The workbook is rebuilt from a snapshot's model.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { rollup } from '../../public/lib/wf4-rollup.js';
import { buildBom, diffItems, revisionChanges, causeFor } from '../../public/lib/wf8-bom.js';
import { priceItems, pricingSummary, partsList } from '../../public/lib/wf8-pricing.js';

async function fetchAll(query, pageSize = 1000) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await query().order('id').range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) return all;
    from += pageSize;
  }
}
const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data || []; };

async function gather(db, P) {
  const { data: project, error: pe } = await db.from('projects').select('id, name, device_library_id, parts_catalog_id, material_margin, labor_rate, co_pricing_basis').eq('id', P).single();
  if (pe) throw new Error(pe.message);
  const [steps, trs, room, rules, elev, feeds, cables, allow, head, ends, sheets] = await Promise.all([
    db.from('workflow_steps').select('step_code, status').eq('project_id', P),
    db.from('trs').select('tr_number, building, level, status, cat6a_terminations, min_patch_panels, source, override_basis').eq('project_id', P),
    db.from('tr_room_devices').select('tr_name, category, quantity, source, override_basis').eq('project_id', P),
    db.from('rack_rules').select('rule_key, note_kind, note_number, ref, item, part_number, ru, qty_rule, zone, params, stated_on_sheet, source, override_basis, confirmed_at').eq('project_id', P),
    db.from('rack_elevations').select('detail_ref, title, rack_count, capacity_passive, capacity_active, active_over').eq('project_id', P),
    db.from('riser_feeds').select('riser_key, riser_label, building, floor, tr_name, core_a_note, core_b_note, match_kind, confirmed_at').eq('project_id', P),
    db.from('riser_cables').select('note_number, note_text, strands_text, strands_per_core, isp_osp, confirmed_at').eq('project_id', P),
    db.from('allowances').select('allowance_key, system, item, per_unit_qty, unit, unit_count, per_text, note_ref, source, override_basis, confirmed_at').eq('project_id', P),
    db.from('riser_head_end').select('core, note_number, qty').eq('project_id', P),
    db.from('osp_nodes').select('tr_name').eq('project_id', P).eq('kind', 'end'),
    db.from('sheets').select('sheet_number, step_code, current_revision_id, sheet_revisions!sheet_revisions_sheet_id_fkey(id, rev_label)').eq('project_id', P),
  ]);
  const [pages, devices, types] = await Promise.all([
    fetchAll(() => db.from('pages').select('id, role, level, is_duplicate, page_number, title_text').eq('project_id', P)),
    fetchAll(() => db.from('device_instances').select('id, page_id, device_type_id, level, tr_name, route_ft, route_method, route_multiplier, tia_flag, excluded, flags, source, confidence').eq('project_id', P)),
    project.device_library_id ? fetchAll(() => db.from('device_types').select('id, name, ports').eq('library_id', project.device_library_id)) : Promise.resolve([]),
  ]);
  const revisions = {};
  for (const s of must(sheets)) {
    const cur = (s.sheet_revisions || []).find((r) => r.id === s.current_revision_id);
    if (s.sheet_number && cur) revisions[s.sheet_number] = { rev: cur.rev_label, step: s.step_code || null };
  }
  const data = {
    steps: Object.fromEntries(must(steps).map((s) => [s.step_code, s.status])),
    trs: must(trs), room: must(room),
    wf4: { rollup: rollup(devices, pages, types), types },
    wf6: { rules: must(rules), elevations: must(elev) },
    wf7: { feeds: must(feeds), cables: must(cables), allowances: must(allow), head_end: must(head), wf3_ends: [...new Set(must(ends).map((e) => e.tr_name).filter(Boolean))] },
  };
  return { project, data, revisions };
}

async function loadPricing(db, project, items) {
  const [parts, asm] = await Promise.all([
    project.parts_catalog_id ? fetchAll(() => db.from('parts').select('id, part_number, manufacturer:mfr, description, unit, unit_cost, labor_min, category, source_url, notes, updated_at').eq('catalog_id', project.parts_catalog_id)) : Promise.resolve([]),
    fetchAll(() => db.from('assemblies').select('id, item_key, item_label, part_number, qty, waste, note, source').eq('project_id', project.id)),
  ]);
  const priced = priceItems(items, asm, parts);
  const byKey = Object.fromEntries([...priced.entries()].map(([k, v]) => [k, { status: v.status, unit_cost: v.unit_cost, labor_min: v.labor_min, missing: v.missing }]));
  const margin = project.material_margin == null ? null : Number(project.material_margin);
  const rate = project.labor_rate == null ? null : Number(project.labor_rate);
  return { parts, assemblies: asm, byKey, summary: pricingSummary(items, priced), parts_list: partsList(items, asm, parts), margin, rate };
}
function pricingNotes(model, pr) {
  const out = [];
  if (!pr.assemblies.length) out.push({ topic: 'Pricing', text: 'No parts catalog / assemblies loaded — unit cost, margin and labor are left for you to fill in.' });
  else {
    out.push({ topic: 'Pricing', text: `${pr.summary.priced} of ${pr.summary.items} BOM items priced from the parts catalog; margin ${pr.margin == null ? 'not set' : (pr.margin * 100).toFixed(1) + '%'}, labor rate ${pr.rate == null ? 'not set' : '$' + pr.rate + '/hr'}.` });
    for (const it of model.items) { const b = pr.byKey[it.key]; if (b?.status === 'partial') out.push({ topic: `Not fully priced — ${it.item}`, text: `left blank: ${b.missing.join(', ')}` }); }
  }
  return out;
}
const pricesSnapshot = (pr) => ({ byKey: pr.byKey, margin: pr.margin, rate: pr.rate, parts_list: pr.parts_list });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  try {
    const listSnapshots = async (P) => must(await db.from('bom_snapshots').select('id, kind, label, created_at, sheet_revisions, stats:quantities->stats')
      .eq('project_id', P).order('created_at', { ascending: false }));
    const reference = (snaps) => snaps.find((s) => s.kind === 'reference') || null;

    if (req.method === 'GET') {
      const P = new URL(req.url).searchParams.get('project_id');
      if (!(await assertWfProjectInOrg(supabase, P, orgId))) return err('Project not found', 404);
      const { project, data, revisions } = await gather(db, P);
      const model = buildBom(data);
      const pricing = await loadPricing(db, project, model.items);
      let catalog = null;
      if (project.parts_catalog_id) catalog = (await db.from('parts_catalogs').select('id, name').eq('id', project.parts_catalog_id).maybeSingle()).data;
      const snaps = await listSnapshots(P);
      const cos = must(await db.from('change_orders').select('id, number, status, pricing_basis, base_snapshot_id, current_snapshot_id, created_at').eq('project_id', P).order('created_at', { ascending: false }));
      return ok({ project: { id: project.id, name: project.name, material_margin: pricing.margin, labor_rate: pricing.rate, co_pricing_basis: project.co_pricing_basis },
        model, revisions, snapshots: snaps, reference: reference(snaps), change_orders: cos,
        pricing: { catalog, parts: pricing.parts, assemblies: pricing.assemblies, byKey: pricing.byKey, summary: pricing.summary, parts_list: pricing.parts_list } });
    }

    if (req.method !== 'POST') return err('Method not allowed', 405);
    let b;
    try { b = await req.json(); } catch { return err('Invalid JSON'); }
    if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
    const P = b.project_id;

    const insertSnapshot = async (kind, label, model, revisions, prices = {}) => {
      const { data, error } = await db.from('bom_snapshots').insert({
        org_id: orgId, project_id: P, kind, label: String(label || '').slice(0, 120) || null,
        quantities: { model, items: model.items, stats: model.stats }, prices, sheet_revisions: revisions, created_by: user.id,
      }).select('id, kind, label, created_at').single();
      if (error) throw new Error(error.message);
      return data;
    };
    const getSnapshot = async (id) => {
      const { data, error } = await db.from('bom_snapshots').select('id, kind, label, created_at, quantities, prices, sheet_revisions').eq('project_id', P).eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };

    if (b.action === 'generate') {
      const { project, data, revisions } = await gather(db, P);
      const model = buildBom(data);
      const pr = await loadPricing(db, project, model.items);
      model.sheets.notes.push(...pricingNotes(model, pr));
      const prices = pricesSnapshot(pr);
      const n = (await listSnapshots(P)).filter((s) => s.kind === 'generated').length + 1;
      const snapshot = await insertSnapshot('generated', b.label || `Generated #${n}`, model, revisions, prices);
      return ok({ snapshot, model, prices });
    }
    if (b.action === 'snapshot') {
      const s = await getSnapshot(b.snapshot_id);
      if (!s) return err('Snapshot not found', 404);
      return ok(s);
    }
    if (b.action === 'pin') {
      const s = await getSnapshot(b.snapshot_id);
      if (!s) return err('Snapshot not found', 404);
      if (!s.quantities?.model) return err('This snapshot has no model to pin');
      const snapshot = await insertSnapshot('reference', `Reference ← ${s.label || '#' + s.id}`, s.quantities.model, s.sheet_revisions || {}, s.prices || {});
      return ok({ snapshot });
    }

    const coLines = async () => {
      const snaps = await listSnapshots(P);
      const ref = reference(snaps);
      if (!ref) throw new Error('No reference yet — generate the BOM and pin a snapshot as the reference first');
      const full = await getSnapshot(ref.id);
      const { project, data, revisions } = await gather(db, P);
      const model = buildBom(data);
      const changes = revisionChanges(full.sheet_revisions || {}, revisions);
      const lines = diffItems(full.quantities?.items || [], model.items).map((l) => ({ ...l, ...causeFor(l, changes) }));
      return { ref, full, project, model, revisions, changes, lines };
    };
    if (b.action === 'co_preview') {
      const { ref, changes, lines } = await coLines();
      return ok({ reference: ref, changes, lines });
    }
    if (b.action === 'create_co') {
      const { ref, full, project, model, revisions, lines } = await coLines();
      if (!lines.length) return err('Nothing has changed since the reference — no change order to create');
      const basis = ['bid', 'current'].includes(b.pricing_basis) ? b.pricing_basis : project.co_pricing_basis || 'bid';
      const cur = await loadPricing(db, project, model.items);
      const priceSrc = basis === 'bid' ? (full.prices || {}) : pricesSnapshot(cur);
      const existing = must(await db.from('change_orders').select('number').eq('project_id', P));
      const number = String(b.number || '').trim() || `CO-${String(existing.length + 1).padStart(2, '0')}`;
      if (existing.some((c) => c.number === number)) return err(`${number} already exists`);
      const snap = await insertSnapshot('co', number, model, revisions, { ...priceSrc, basis });
      const { data: co, error } = await db.from('change_orders').insert({
        org_id: orgId, project_id: P, number, base_snapshot_id: ref.id, current_snapshot_id: snap.id, pricing_basis: basis, status: 'draft',
      }).select('id, number, status, created_at').single();
      if (error) return err(error.message, 500);
      const rows = lines.map((l) => ({
        org_id: orgId, project_id: P, change_order_id: co.id, bom_item: l.item.slice(0, 300), description: `${l.step} · ${l.key}`.slice(0, 300),
        unit: l.unit, ref_qty: l.ref_qty, cur_qty: l.cur_qty, unit_price: priceSrc.byKey?.[l.key]?.unit_cost ?? null, line_type: l.line_type,
        cause_kind: l.cause_kind, cause_note: l.cause_note?.slice(0, 500) || null,
      }));
      const { error: le } = await db.from('change_order_lines').insert(rows);
      if (le) return err(le.message, 500);
      return ok({ change_order: co, lines: lines.length });
    }
    if (b.action === 'co') {
      const { data: co, error } = await db.from('change_orders').select('id, number, status, pricing_basis, base_snapshot_id, current_snapshot_id, created_at').eq('project_id', P).eq('id', b.change_order_id).maybeSingle();
      if (error) return err(error.message, 500);
      if (!co) return err('Change order not found', 404);
      const lines = must(await db.from('change_order_lines').select('bom_item, description, unit, ref_qty, cur_qty, delta, line_type, cause_kind, cause_note').eq('change_order_id', co.id).order('id'));
      const base = await getSnapshot(co.base_snapshot_id);
      const cs = co.current_snapshot_id ? await getSnapshot(co.current_snapshot_id) : null;
      const pk = cs?.prices?.byKey || {};
      return ok({ change_order: co, reference_label: base?.label || null, margin: cs?.prices?.margin ?? null, rate: cs?.prices?.rate ?? null,
        lines: lines.map((l) => { const key = String(l.description || '').split(' · ').slice(1).join(' · ');
          return { ...l, item: l.bom_item, unit_cost: l.unit_price ?? pk[key]?.unit_cost ?? null, labor_min: pk[key]?.labor_min ?? null }; }) });
    }

    // ── pass 2: pricing settings, catalog, parts, assemblies ──
    const proj = async () => {
      const { data, error } = await db.from('projects').select('id, name, parts_catalog_id').eq('id', P).single();
      if (error) throw new Error(error.message);
      return data;
    };
    const ensureCatalog = async () => {
      const pj = await proj();
      if (pj.parts_catalog_id) return pj.parts_catalog_id;
      let name = `${pj.name} parts`;
      const { data: dup } = await db.from('parts_catalogs').select('id').eq('org_id', orgId).eq('name', name).maybeSingle();
      if (dup) name = `${name} ${Date.now().toString(36)}`;
      const { data: cat, error } = await db.from('parts_catalogs').insert({ org_id: orgId, name, created_by: user.id }).select('id').single();
      if (error) throw new Error(error.message);
      const { error: ue } = await db.from('projects').update({ parts_catalog_id: cat.id }).eq('id', P);
      if (ue) throw new Error(ue.message);
      return cat.id;
    };
    const cleanPart = (p) => {
      const pn = String(p?.part_number || '').trim();
      if (!pn) throw new Error('Part number is required');
      const n = (v, what) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[$,]/g, '')); if (!(x >= 0)) throw new Error(`${pn}: ${what} must be 0 or more`); return x; };
      return { part_number: pn.slice(0, 80), mfr: p.manufacturer ? String(p.manufacturer).slice(0, 80) : null, description: p.description ? String(p.description).slice(0, 300) : null,
        unit: String(p.unit || 'ea').slice(0, 12), unit_cost: n(p.unit_cost, 'unit cost'), labor_min: n(p.labor_min, 'labor minutes'),
        category: p.category ? String(p.category).slice(0, 60) : null, source_url: p.source_url ? String(p.source_url).slice(0, 300) : null,
        notes: p.notes ? String(p.notes).slice(0, 300) : null };
    };
    const upsertParts = async (catalogId, list) => {
      if (!list.length) return 0;
      const rows = list.map((p) => ({ ...cleanPart(p), org_id: orgId, catalog_id: catalogId, retrieved_at: new Date().toISOString(), updated_by: user.id, updated_at: new Date().toISOString() }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('parts').upsert(rows.slice(i, i + 500), { onConflict: 'catalog_id,part_number' });
        if (error) throw new Error(error.message);
      }
      return rows.length;
    };
    const cleanLine = (l) => {
      const key = String(l?.item_key || '').trim(), pn = String(l?.part_number || '').trim();
      if (!/^wf\d:[A-Za-z0-9:_\-. ]{1,120}$/.test(key)) throw new Error(`"${key}" is not a BOM item key`);
      if (!pn) throw new Error('Part number is required');
      const qty = Number(l.qty ?? 1), waste = Number(l.waste ?? 1);
      if (!(qty >= 0)) throw new Error(`${pn}: qty must be 0 or more`);
      if (!(waste >= 1)) throw new Error(`${pn}: waste must be 1 or more (1.05 = 5% waste)`);
      return { item_key: key, item_label: l.item_label ? String(l.item_label).slice(0, 300) : null, part_number: pn.slice(0, 80), qty, waste, note: l.note ? String(l.note).slice(0, 300) : null };
    };

    if (b.action === 'settings') {
      const patch = {};
      if ('material_margin' in b) { const m = b.material_margin === '' || b.material_margin == null ? null : Number(b.material_margin); if (m != null && !(m >= 0 && m < 1)) return err('Margin must be between 0 and 1 (e.g. 0.1 for 10%)'); patch.material_margin = m; }
      if ('labor_rate' in b) { const r = b.labor_rate === '' || b.labor_rate == null ? null : Number(b.labor_rate); if (r != null && !(r >= 0)) return err('Labor rate must be 0 or more'); patch.labor_rate = r; }
      if ('co_pricing_basis' in b) { if (!['bid', 'current'].includes(b.co_pricing_basis)) return err('Pricing basis must be bid or current'); patch.co_pricing_basis = b.co_pricing_basis; }
      const { error } = await db.from('projects').update(patch).eq('id', P);
      if (error) return err(error.message, 500);
      return ok({ saved: Object.keys(patch) });
    }
    if (b.action === 'catalogs') {
      return ok(must(await db.from('parts_catalogs').select('id, name, created_at').eq('org_id', orgId).order('name')));
    }
    if (b.action === 'set_catalog') {
      const { data: cat } = await db.from('parts_catalogs').select('id').eq('org_id', orgId).eq('id', b.catalog_id).maybeSingle();
      if (!cat) return err('Catalog not found', 404);
      const { error } = await db.from('projects').update({ parts_catalog_id: cat.id }).eq('id', P);
      if (error) return err(error.message, 500);
      return ok({ catalog_id: cat.id });
    }
    if (b.action === 'save_part') {
      const cat = await ensureCatalog();
      await upsertParts(cat, [b.part]);
      return ok({ saved: 1 });
    }
    if (b.action === 'delete_part') {
      const pj = await proj();
      if (!pj.parts_catalog_id) return err('No catalog');
      const { error } = await db.from('parts').delete().eq('catalog_id', pj.parts_catalog_id).eq('part_number', String(b.part_number || ''));
      if (error) return err(error.message, 500);
      return ok({ deleted: b.part_number });
    }
    if (b.action === 'save_line') {
      const l = cleanLine(b);
      const { error } = await db.from('assemblies').upsert({ ...l, org_id: orgId, project_id: P, source: 'manual', entered_by: user.id, entered_at: new Date().toISOString() },
        { onConflict: 'project_id,item_key,part_number' });
      if (error) return err(error.message, 500);
      return ok({ saved: 1 });
    }
    if (b.action === 'delete_line') {
      const { error } = await db.from('assemblies').delete().eq('project_id', P).eq('item_key', String(b.item_key || '')).eq('part_number', String(b.part_number || ''));
      if (error) return err(error.message, 500);
      return ok({ deleted: 1 });
    }
    if (b.action === 'import') {
      const parts = Array.isArray(b.parts) ? b.parts : [];
      const lines = (Array.isArray(b.assemblies) ? b.assemblies : []).map(cleanLine);
      const replace = [...new Set((Array.isArray(b.replace_items) ? b.replace_items : []).map(String))];
      let nParts = 0;
      if (parts.length) nParts = await upsertParts(await ensureCatalog(), parts);
      if (replace.length) {
        for (let i = 0; i < replace.length; i += 200) {
          const { error } = await db.from('assemblies').delete().eq('project_id', P).in('item_key', replace.slice(i, i + 200));
          if (error) return err(error.message, 500);
        }
      }
      if (lines.length) {
        const rows = lines.map((l) => ({ ...l, org_id: orgId, project_id: P, source: 'imported', entered_by: user.id, entered_at: new Date().toISOString() }));
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await db.from('assemblies').insert(rows.slice(i, i + 500));
          if (error) return err(error.message, 500);
        }
      }
      return ok({ parts: nParts, lines: lines.length, items_replaced: replace.length });
    }

    return err('Unknown action');
  } catch (e) {
    return err(e.message, e.message.startsWith('No reference') || e.message.startsWith('Nothing') ? 400 : 500);
  }
}

export const config = { path: '/api/wf/wf8/bom' };
