// netlify/functions/wf6-rules.js
// WF6 Rack & details — rules read from the rack elevation sheet. Free (no model calls).
//
// GET  /api/wf/wf6/rules?project_id=9
//   -> { rules, elevations, trs:[{ tr_name, racks, panels, terminations, isp_osp, wall_mount }] }
//      racks = WF5 new racks (null when not entered), panels/terminations = WF2, isp_osp = WF7.
// POST /api/wf/wf6/rules
//   { action:'save_read', project_id, page_id, sheet_revision_id?, rules:[...], elevations:[...] }
//        Rows the user has edited keep their values; a different read is kept in `conflict`.
//        Extracted rows the new read no longer has are removed. Elevations for the page are replaced.
//   { action:'save_rule', project_id, rule_key, patch:{ item?, part_number?, ru?, qty_rule?, zone?, params? }, basis? }
//   { action:'accept_read', project_id, rule_key }     take the sheet's newer read for an edited row
//   { action:'add_rule', project_id, rule:{ item, part_number?, ru?, qty_rule, params? }, basis? }
//   { action:'delete_rule', project_id, rule_key }      rows the user added only
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { METHOD_KEYS } from '../../public/lib/wf6-rules.js';

const RULE_COLS = 'id, rule_key, note_kind, note_number, ref, item, part_number, ru, qty_rule, zone, params, note_text, stated_on_sheet, source, page_id, sheet_revision_id, original_value, override_basis, conflict, entered_at';
const ZONES = [null, 'top', 'middle', 'bottom', 'side'];
const SHEET_FIELDS = ['item', 'part_number', 'ru', 'qty_rule', 'zone', 'params', 'note_text', 'stated_on_sheet', 'ref', 'note_kind', 'note_number'];

function cleanParams(p) {
  if (p == null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('params must be an object');
  const out = {};
  for (const [k, x] of Object.entries(p)) {
    if (!/^[a-z_]{1,40}$/.test(k)) throw new Error(`bad param name "${k}"`);
    if (!x || typeof x !== 'object' || !('v' in x)) throw new Error(`param ${k} must be { v, source }`);
    const src = ['sheet', 'user', 'default'].includes(x.source) ? x.source : 'user';
    if (x.v !== null && !['number', 'boolean', 'string'].includes(typeof x.v)) throw new Error(`param ${k} has a bad value`);
    if (typeof x.v === 'number' && !(x.v >= 0)) throw new Error(`param ${k} must be 0 or more`);
    out[k] = { v: x.v, source: src };
  }
  return out;
}
function cleanRule(r) {
  if (!r || typeof r.rule_key !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(r.rule_key)) throw new Error('bad rule_key');
  if (!METHOD_KEYS.includes(r.qty_rule)) throw new Error(`${r.rule_key}: unknown counting method "${r.qty_rule}"`);
  if (!ZONES.includes(r.zone ?? null)) throw new Error(`${r.rule_key}: bad zone`);
  if (!String(r.item || '').trim()) throw new Error(`${r.rule_key}: item is empty`);
  return {
    rule_key: r.rule_key, note_kind: ['coded', 'drawing', 'manual'].includes(r.note_kind) ? r.note_kind : 'manual',
    note_number: Number.isInteger(r.note_number) ? r.note_number : null, ref: r.ref ? String(r.ref).slice(0, 20) : null,
    item: String(r.item).trim().slice(0, 400), part_number: r.part_number ? String(r.part_number).slice(0, 200) : null,
    ru: r.ru == null || r.ru === '' ? null : Number(r.ru), qty_rule: r.qty_rule, zone: r.zone ?? null,
    params: cleanParams(r.params), note_text: r.note_text ? String(r.note_text).slice(0, 4000) : null,
    stated_on_sheet: r.stated_on_sheet !== false,
  };
}
const sheetView = (r) => Object.fromEntries(SHEET_FIELDS.map((k) => [k, r[k] ?? null]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  try {
    if (req.method === 'GET') {
      const projectId = new URL(req.url).searchParams.get('project_id');
      if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
      const [rules, elev, trs, racks, feeds] = await Promise.all([
        db.from('rack_rules').select(RULE_COLS).eq('project_id', projectId).order('note_kind').order('note_number').order('rule_key'),
        db.from('rack_elevations').select('id, page_id, detail_ref, title, rack_count, capacity_passive, capacity_active, active_over, capacity_text, source').eq('project_id', projectId).order('detail_ref'),
        db.from('trs').select('id, tr_number, cat6a_terminations, min_patch_panels').eq('project_id', projectId).order('tr_number'),
        db.from('tr_room_devices').select('tr_name, category, quantity').eq('project_id', projectId),
        db.from('riser_feeds').select('tr_name, isp_osp').eq('project_id', projectId),
      ]);
      for (const r of [rules, elev, trs, racks, feeds]) if (r.error) return err(r.error.message, 500);
      const rackBy = new Map((racks.data || []).filter((x) => x.category === 'rack_new').map((x) => [x.tr_name, Number(x.quantity)]));
      const wallBy = new Set((racks.data || []).filter((x) => x.category === 'wall_mount' && Number(x.quantity) > 0).map((x) => x.tr_name));
      const inWf5 = new Set((racks.data || []).map((x) => x.tr_name));
      const plantBy = new Map((feeds.data || []).filter((x) => x.isp_osp).map((x) => [x.tr_name, x.isp_osp]));
      return ok({
        rules: rules.data || [], elevations: elev.data || [],
        trs: (trs.data || []).filter((t) => t.tr_number).map((t) => ({
          tr_name: t.tr_number, racks: rackBy.has(t.tr_number) ? rackBy.get(t.tr_number) : null,
          panels: t.min_patch_panels, terminations: t.cat6a_terminations, isp_osp: plantBy.get(t.tr_number) || null,
          // WF5 checkbox: true when ticked; false once the room has anything entered in WF5; null if WF5 has nothing for it.
          wall_mount: wallBy.has(t.tr_number) ? true : inWf5.has(t.tr_number) ? false : null,
        })),
      });
    }

    if (req.method !== 'POST') return err('Method not allowed', 405);
    let b;
    try { b = await req.json(); } catch { return err('Invalid JSON'); }
    if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
    const P = b.project_id;
    const now = new Date().toISOString();

    const getRule = async (key) => {
      const { data, error } = await db.from('rack_rules').select(RULE_COLS).eq('project_id', P).eq('rule_key', key).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };

    if (b.action === 'save_read') {
      const { data: page } = await db.from('pages').select('id').eq('project_id', P).eq('id', b.page_id).maybeSingle();
      if (!page) return err('Page not found in this project', 404);
      const incoming = (b.rules || []).map(cleanRule);
      const { data: existing, error: exErr } = await db.from('rack_rules').select(RULE_COLS).eq('project_id', P);
      if (exErr) return err(exErr.message, 500);
      const byKey = new Map(existing.map((r) => [r.rule_key, r]));
      let inserted = 0, updated = 0, conflicts = 0, removed = 0;
      for (const r of incoming) {
        const cur = byKey.get(r.rule_key);
        const base = { page_id: page.id, sheet_revision_id: b.sheet_revision_id || null };
        if (!cur) {
          const { error } = await db.from('rack_rules').insert({ ...r, ...base, org_id: orgId, project_id: P, source: 'extracted', entered_by: user.id, entered_at: now });
          if (error) return err(`${r.rule_key}: ${error.message}`, 500);
          inserted++;
        } else if (cur.source === 'extracted' || cur.source === 'imported') {
          const { error } = await db.from('rack_rules').update({ ...r, ...base, conflict: null, entered_by: user.id, entered_at: now }).eq('id', cur.id);
          if (error) return err(`${r.rule_key}: ${error.message}`, 500);
          updated++;
        } else {
          const was = cur.original_value || sheetView(cur);
          const conflict = same(sheetView(r), was) ? null : sheetView(r);
          const { error } = await db.from('rack_rules').update({ conflict }).eq('id', cur.id);
          if (error) return err(`${r.rule_key}: ${error.message}`, 500);
          if (conflict) conflicts++;
        }
      }
      const keys = new Set(incoming.map((r) => r.rule_key));
      const stale = existing.filter((r) => r.source === 'extracted' && r.page_id === page.id && !keys.has(r.rule_key));
      for (const r of stale) { await db.from('rack_rules').delete().eq('id', r.id); removed++; }

      await db.from('rack_elevations').delete().eq('project_id', P).eq('page_id', page.id);
      const elev = (b.elevations || []).filter((e) => ['1', '2', '3', '4', 'wall_mount'].includes(String(e.rack_count))).map((e) => ({
        org_id: orgId, project_id: P, page_id: page.id, sheet_revision_id: b.sheet_revision_id || null,
        detail_ref: e.detail_ref ? String(e.detail_ref).slice(0, 10) : null, title: String(e.title || '').slice(0, 200),
        rack_count: String(e.rack_count), capacity_passive: Number.isFinite(e.capacity_passive) ? e.capacity_passive : null,
        capacity_active: Number.isFinite(e.capacity_active) ? e.capacity_active : null, active_over: !!e.active_over,
        capacity_text: e.capacity_text ? String(e.capacity_text).slice(0, 500) : null,
        source: 'extracted', entered_by: user.id, entered_at: now,
      }));
      if (elev.length) {
        const { error } = await db.from('rack_elevations').insert(elev);
        if (error) return err(error.message, 500);
      }
      return ok({ inserted, updated, conflicts, removed, elevations: elev.length });
    }

    if (b.action === 'save_rule') {
      const cur = await getRule(b.rule_key);
      if (!cur) return err('Rule not found', 404);
      const next = cleanRule({ ...cur, ...(b.patch || {}), params: { ...(cur.params || {}), ...((b.patch || {}).params || {}) } });
      const basis = String(b.basis || '').trim() || 'Set by user';
      const upd = {
        item: next.item, part_number: next.part_number, ru: next.ru, qty_rule: next.qty_rule, zone: next.zone, params: next.params,
        source: cur.source === 'manual' ? 'manual' : 'edited', override_basis: basis,
        original_value: cur.source === 'extracted' ? sheetView(cur) : cur.original_value,
        entered_by: user.id, entered_at: now,
      };
      const { data, error } = await db.from('rack_rules').update(upd).eq('id', cur.id).select(RULE_COLS).single();
      if (error) return err(error.message, 500);
      return ok(data);
    }

    if (b.action === 'accept_read') {
      const cur = await getRule(b.rule_key);
      if (!cur || !cur.conflict) return err('No newer sheet read for this rule', 404);
      const r = cleanRule({ ...cur.conflict, rule_key: cur.rule_key });
      const { data, error } = await db.from('rack_rules')
        .update({ ...r, source: 'extracted', override_basis: null, original_value: null, conflict: null, entered_by: user.id, entered_at: now })
        .eq('id', cur.id).select(RULE_COLS).single();
      if (error) return err(error.message, 500);
      return ok(data);
    }

    if (b.action === 'add_rule') {
      const r = cleanRule({ ...(b.rule || {}), rule_key: 'M' + Date.now().toString(36), note_kind: 'manual', stated_on_sheet: false });
      const { data, error } = await db.from('rack_rules').insert({
        ...r, org_id: orgId, project_id: P, source: 'manual', override_basis: String(b.basis || '').trim() || 'Added by user — not on the sheet',
        entered_by: user.id, entered_at: now,
      }).select(RULE_COLS).single();
      if (error) return err(error.message, 500);
      return ok(data);
    }

    if (b.action === 'delete_rule') {
      const cur = await getRule(b.rule_key);
      if (!cur) return err('Rule not found', 404);
      if (cur.source !== 'manual') return err('Only rules you added can be deleted; set a sheet rule to "Not counted" instead');
      const { error } = await db.from('rack_rules').delete().eq('id', cur.id);
      if (error) return err(error.message, 500);
      return ok({ deleted: b.rule_key });
    }

    return err('Unknown action');
  } catch (e) {
    return err(e.message, e.message.includes(':') || e.message.startsWith('bad') || e.message.startsWith('param') ? 400 : 500);
  }
}

export const config = { path: '/api/wf/wf6/rules' };
