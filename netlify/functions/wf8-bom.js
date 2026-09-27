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
// Snapshots are immutable (database trigger). The workbook is rebuilt from a snapshot's model.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { rollup } from '../../public/lib/wf4-rollup.js';
import { buildBom, diffItems, revisionChanges, causeFor } from '../../public/lib/wf8-bom.js';

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
  const { data: project, error: pe } = await db.from('projects').select('id, name, device_library_id').eq('id', P).single();
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
      const snaps = await listSnapshots(P);
      const cos = must(await db.from('change_orders').select('id, number, status, pricing_basis, base_snapshot_id, current_snapshot_id, created_at').eq('project_id', P).order('created_at', { ascending: false }));
      return ok({ project: { id: project.id, name: project.name }, model, revisions, snapshots: snaps, reference: reference(snaps), change_orders: cos });
    }

    if (req.method !== 'POST') return err('Method not allowed', 405);
    let b;
    try { b = await req.json(); } catch { return err('Invalid JSON'); }
    if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
    const P = b.project_id;

    const insertSnapshot = async (kind, label, model, revisions) => {
      const { data, error } = await db.from('bom_snapshots').insert({
        org_id: orgId, project_id: P, kind, label: String(label || '').slice(0, 120) || null,
        quantities: { model, items: model.items, stats: model.stats }, prices: {}, sheet_revisions: revisions, created_by: user.id,
      }).select('id, kind, label, created_at').single();
      if (error) throw new Error(error.message);
      return data;
    };
    const getSnapshot = async (id) => {
      const { data, error } = await db.from('bom_snapshots').select('id, kind, label, created_at, quantities, sheet_revisions').eq('project_id', P).eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };

    if (b.action === 'generate') {
      const { data, revisions } = await gather(db, P);
      const model = buildBom(data);
      const n = (await listSnapshots(P)).filter((s) => s.kind === 'generated').length + 1;
      const snapshot = await insertSnapshot('generated', b.label || `Generated #${n}`, model, revisions);
      return ok({ snapshot, model });
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
      const snapshot = await insertSnapshot('reference', `Reference ← ${s.label || '#' + s.id}`, s.quantities.model, s.sheet_revisions || {});
      return ok({ snapshot });
    }

    const coLines = async () => {
      const snaps = await listSnapshots(P);
      const ref = reference(snaps);
      if (!ref) throw new Error('No reference yet — generate the BOM and pin a snapshot as the reference first');
      const full = await getSnapshot(ref.id);
      const { data, revisions } = await gather(db, P);
      const model = buildBom(data);
      const changes = revisionChanges(full.sheet_revisions || {}, revisions);
      const lines = diffItems(full.quantities?.items || [], model.items).map((l) => ({ ...l, ...causeFor(l, changes) }));
      return { ref, model, revisions, changes, lines };
    };
    if (b.action === 'co_preview') {
      const { ref, changes, lines } = await coLines();
      return ok({ reference: ref, changes, lines });
    }
    if (b.action === 'create_co') {
      const { ref, model, revisions, lines } = await coLines();
      if (!lines.length) return err('Nothing has changed since the reference — no change order to create');
      const existing = must(await db.from('change_orders').select('number').eq('project_id', P));
      const number = String(b.number || '').trim() || `CO-${String(existing.length + 1).padStart(2, '0')}`;
      if (existing.some((c) => c.number === number)) return err(`${number} already exists`);
      const snap = await insertSnapshot('co', number, model, revisions);
      const { data: co, error } = await db.from('change_orders').insert({
        org_id: orgId, project_id: P, number, base_snapshot_id: ref.id, current_snapshot_id: snap.id, pricing_basis: 'bid', status: 'draft',
      }).select('id, number, status, created_at').single();
      if (error) return err(error.message, 500);
      const rows = lines.map((l) => ({
        org_id: orgId, project_id: P, change_order_id: co.id, bom_item: l.item.slice(0, 300), description: `${l.step} · ${l.key}`.slice(0, 300),
        unit: l.unit, ref_qty: l.ref_qty, cur_qty: l.cur_qty, unit_price: null, line_type: l.line_type,
        cause_kind: l.cause_kind, cause_note: l.cause_note?.slice(0, 500) || null,
      }));
      const { error: le } = await db.from('change_order_lines').insert(rows);
      if (le) return err(le.message, 500);
      return ok({ change_order: co, lines: lines.length });
    }
    if (b.action === 'co') {
      const { data: co, error } = await db.from('change_orders').select('id, number, status, pricing_basis, base_snapshot_id, created_at').eq('project_id', P).eq('id', b.change_order_id).maybeSingle();
      if (error) return err(error.message, 500);
      if (!co) return err('Change order not found', 404);
      const lines = must(await db.from('change_order_lines').select('bom_item, description, unit, ref_qty, cur_qty, delta, line_type, cause_kind, cause_note').eq('change_order_id', co.id).order('id'));
      const base = await getSnapshot(co.base_snapshot_id);
      return ok({ change_order: co, reference_label: base?.label || null, lines: lines.map((l) => ({ ...l, item: l.bom_item })) });
    }

    return err('Unknown action');
  } catch (e) {
    return err(e.message, e.message.startsWith('No reference') || e.message.startsWith('Nothing') ? 400 : 500);
  }
}

export const config = { path: '/api/wf/wf8/bom' };
