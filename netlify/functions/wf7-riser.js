// netlify/functions/wf7-riser.js
// WF7 Riser — read from the riser diagram sheet. Free (no model calls).
//
// GET  /api/wf/wf7/riser?project_id=9
//   -> { cables, feeds, head_end, allowances, trs:[tr_number], wf3_ends:[tr_name], wf6_strands:{isp,osp}|null }
// POST /api/wf/wf7/riser  { action, project_id, ... }
//   save_read        { page_id, sheet_revision_id?, cables, blocks, head_end, allowances }
//   set_cable        { note_number, isp_osp, basis? }            confirm_cable { note_number, confirmed }
//   set_match        { riser_key, tr_name|null }                 match a riser TR to a schedule TR by hand (null = out)
//   accept_match     { riser_key }                               take the close schedule match
//   add_in           { riser_key, tr_name? }                     add a riser TR that is not on the schedule to the TR list
//   take_out         { riser_key }                               undo add-in / match (an added TR with no WF5 data is removed)
//   set_cores        { riser_key, core_a_note, core_b_note, basis? }
//   confirm_feed     { riser_key, confirmed }                    confirm_ready_feeds {}
//   set_allowance    { allowance_key, patch:{ item?, per_unit_qty?, unit?, unit_count?, per_text? }, basis? }
//   confirm_allowance{ allowance_key, confirmed }                confirm_ready_allowances {}
// Any edit, or a re-read that changes an item, clears its confirmation.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { matchRiserTr, feedBlocker, feedType, cableBlocker, allowanceBlocker } from '../../public/lib/wf7-riser.js';

const CABLE_COLS = 'id, note_number, note_text, strands, strands_per_core, strands_text, isp_osp, basis, source, page_id, override_basis, original_value, conflict, confirmed_at';
const FEED_COLS = 'id, riser_key, riser_label, building, floor, tr_name_read, tr_name, core_a, core_b, core_a_note, core_b_note, match_kind, suggested_tr, isp_osp, source, override_basis, original_value, conflict, confirmed_at, page_id';
const ALLOW_COLS = 'id, allowance_key, system, item, per_unit_qty, unit, unit_count, total, per_text, note_ref, source, override_basis, original_value, conflict, confirmed_at, page_id';
const UNCONFIRM = { confirmed_at: null, confirmed_by: null };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const CABLE_READ = ['note_text', 'strands', 'strands_per_core', 'strands_text', 'isp_osp', 'basis'];
const FEED_READ = ['riser_label', 'building', 'floor', 'tr_name_read', 'core_a', 'core_b', 'core_a_note', 'core_b_note'];
const ALLOW_READ = ['system', 'item', 'per_unit_qty', 'unit', 'unit_count', 'per_text', 'note_ref'];
const ADDED_BASIS = 'Added from the riser diagram';

const int = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
const num = (v) => (v == null || v === '' ? null : Number(v) >= 0 ? Number(v) : NaN);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  try {
    if (req.method === 'GET') {
      const P = new URL(req.url).searchParams.get('project_id');
      if (!(await assertWfProjectInOrg(supabase, P, orgId))) return err('Project not found', 404);
      const [cables, feeds, head, allow, trs, ends, rules] = await Promise.all([
        db.from('riser_cables').select(CABLE_COLS).eq('project_id', P).order('note_number'),
        db.from('riser_feeds').select(FEED_COLS).eq('project_id', P).order('id'),
        db.from('riser_head_end').select('core, note_number, qty').eq('project_id', P).order('core').order('note_number'),
        db.from('allowances').select(ALLOW_COLS).eq('project_id', P).order('allowance_key'),
        db.from('trs').select('tr_number, source, override_basis').eq('project_id', P).order('tr_number'),
        db.from('osp_nodes').select('tr_name').eq('project_id', P).eq('kind', 'end'),
        db.from('rack_rules').select('params').eq('project_id', P).eq('qty_rule', 'strands_div_cassette').limit(1),
      ]);
      for (const r of [cables, feeds, head, allow, trs, ends, rules]) if (r.error) return err(r.error.message, 500);
      const pr = rules.data?.[0]?.params;
      return ok({
        cables: cables.data, feeds: feeds.data, head_end: head.data, allowances: allow.data,
        trs: trs.data.map((t) => ({ tr_number: t.tr_number, added_from_riser: t.source === 'manual' && String(t.override_basis || '').startsWith(ADDED_BASIS) })),
        wf3_ends: [...new Set(ends.data.map((e) => e.tr_name).filter(Boolean))],
        wf6_strands: pr ? { isp: pr.strands_isp?.v ?? null, osp: pr.strands_osp?.v ?? null } : null,
      });
    }

    if (req.method !== 'POST') return err('Method not allowed', 405);
    let b;
    try { b = await req.json(); } catch { return err('Invalid JSON'); }
    if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
    const P = b.project_id;
    const now = new Date().toISOString();
    const stamp = { entered_by: user.id, entered_at: now };

    const one = async (table, cols, key, val) => {
      const { data, error } = await db.from(table).select(cols).eq('project_id', P).eq(key, val).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };
    const update = async (table, cols, id, patch) => {
      const { data, error } = await db.from(table).update(patch).eq('id', id).select(cols).single();
      if (error) throw new Error(error.message);
      return data;
    };
    const trList = async () => {
      const { data, error } = await db.from('trs').select('id, tr_number, source, override_basis').eq('project_id', P);
      if (error) throw new Error(error.message);
      return data;
    };
    const cablesNow = async () => {
      const { data, error } = await db.from('riser_cables').select(CABLE_COLS).eq('project_id', P);
      if (error) throw new Error(error.message);
      return data;
    };

    // ── read ──
    if (b.action === 'save_read') {
      const { data: page } = await db.from('pages').select('id').eq('project_id', P).eq('id', b.page_id).maybeSingle();
      if (!page) return err('Page not found in this project', 404);
      const base = { page_id: page.id, sheet_revision_id: b.sheet_revision_id || null };
      const res = { cables: 0, feeds_new: 0, feeds_updated: 0, feeds_removed: 0, conflicts: 0, allowances: 0 };

      // generic upsert for items with the extracted / edited / conflict pattern
      const upsertRead = async (table, cols, keyField, items, readFields) => {
        const { data: existing, error } = await db.from(table).select(cols).eq('project_id', P);
        if (error) throw new Error(error.message);
        const by = new Map(existing.map((r) => [String(r[keyField]), r]));
        for (const it of items) {
          const cur = by.get(String(it[keyField]));
          const read = pick(it, readFields);
          if (!cur) {
            const { error: e } = await db.from(table).insert({ ...it, ...base, org_id: orgId, project_id: P, source: 'extracted', ...stamp });
            if (e) throw new Error(`${table} ${it[keyField]}: ${e.message}`);
          } else if (cur.source === 'extracted' || cur.source === 'imported') {
            const changed = !same(read, pick(cur, readFields));
            await update(table, 'id', cur.id, { ...read, ...base, conflict: null, ...(changed ? UNCONFIRM : {}), ...stamp });
          } else {
            const was = cur.original_value || pick(cur, readFields);
            const conflict = same(read, was) ? null : read;
            await update(table, 'id', cur.id, conflict ? { conflict, ...UNCONFIRM } : { conflict: null });
            if (conflict) res.conflicts++;
          }
        }
        return existing;
      };

      const cables = (b.cables || []).filter((c) => Number.isInteger(c.note_number) && c.note_text).map((c) => ({
        note_number: c.note_number, note_text: String(c.note_text).slice(0, 2000), strands: Array.isArray(c.strands) ? c.strands.slice(0, 10) : [],
        strands_per_core: num(c.strands_per_core), strands_text: c.strands_text ? String(c.strands_text).slice(0, 100) : null,
        isp_osp: ['isp', 'osp'].includes(c.isp_osp) ? c.isp_osp : null, basis: c.basis ? String(c.basis).slice(0, 200) : null,
      }));
      await upsertRead('riser_cables', CABLE_COLS, 'note_number', cables, CABLE_READ);
      res.cables = cables.length;

      // feeds: read fields upserted; schedule matching only decided for new rows
      const trs = await trList();
      const names = trs.map((t) => t.tr_number);
      const { data: exFeeds, error: fe } = await db.from('riser_feeds').select(FEED_COLS).eq('project_id', P);
      if (fe) throw new Error(fe.message);
      const byKey = new Map(exFeeds.map((f) => [f.riser_key, f]));
      const blocks = (b.blocks || []).filter((x) => x && x.riser_key).map((x) => ({
        riser_key: String(x.riser_key).slice(0, 120), riser_label: x.riser_label ? String(x.riser_label).slice(0, 80) : null,
        building: x.building ? String(x.building).slice(0, 80) : null, floor: x.floor ? String(x.floor).slice(0, 60) : null,
        tr_name_read: x.tr_name_read ? String(x.tr_name_read).slice(0, 40) : null,
        core_a: !!x.core_a, core_b: !!x.core_b, core_a_note: int(x.core_a_note), core_b_note: int(x.core_b_note),
      }));
      if (blocks.some((x) => Number.isNaN(x.core_a_note) || Number.isNaN(x.core_b_note))) return err('bad core note number');
      const taken = new Set(exFeeds.filter((f) => f.tr_name).map((f) => f.tr_name));
      for (const x of blocks) {
        const cur = byKey.get(x.riser_key);
        const read = pick(x, FEED_READ);
        if (!cur) {
          const m = matchRiserTr(x.tr_name_read, names);
          const free = m.tr_name && !taken.has(m.tr_name);
          const row = { ...x, ...base, org_id: orgId, project_id: P, source: 'extracted', ...stamp,
            tr_name: m.kind === 'exact' && free ? m.tr_name : null,
            match_kind: m.kind === 'exact' && free ? 'exact' : m.kind === 'close' && free ? 'close' : null,
            suggested_tr: m.kind === 'close' && free ? m.tr_name : null };
          if (row.tr_name) taken.add(row.tr_name);
          const { error } = await db.from('riser_feeds').insert(row);
          if (error) throw new Error(`${x.riser_key}: ${error.message}`);
          res.feeds_new++;
        } else if (cur.source === 'extracted') {
          const changed = !same(read, pick(cur, FEED_READ));
          await update('riser_feeds', 'id', cur.id, { ...read, ...base, conflict: null, ...(changed ? UNCONFIRM : {}), ...stamp });
          if (changed) res.feeds_updated++;
        } else {
          const was = cur.original_value || pick(cur, FEED_READ);
          const conflict = same(read, was) ? null : read;
          await update('riser_feeds', 'id', cur.id, conflict ? { conflict, ...UNCONFIRM } : { conflict: null });
          if (conflict) res.conflicts++;
        }
      }
      // blocks no longer on the sheet: removed, unless the user added them in (then flagged)
      const keys = new Set(blocks.map((x) => x.riser_key));
      for (const f of exFeeds.filter((f) => f.page_id === page.id && !keys.has(f.riser_key))) {
        if (f.match_kind === 'added' || f.match_kind === 'manual') await update('riser_feeds', 'id', f.id, { conflict: { removed_from_sheet: true }, ...UNCONFIRM });
        else { await db.from('riser_feeds').delete().eq('id', f.id); res.feeds_removed++; }
      }

      await db.from('riser_head_end').delete().eq('project_id', P).eq('page_id', page.id);
      const he = (b.head_end || []).filter((h) => Number.isInteger(h.qty) && Number.isInteger(h.note_number))
        .map((h) => ({ org_id: orgId, project_id: P, page_id: page.id, core: h.core ? String(h.core).slice(0, 2) : null, note_number: h.note_number, qty: h.qty }));
      if (he.length) { const { error } = await db.from('riser_head_end').insert(he); if (error) throw new Error(error.message); }

      const allow = (b.allowances || []).filter((a) => a.allowance_key && a.item).map((a) => ({
        allowance_key: String(a.allowance_key).slice(0, 60), system: String(a.system || 'Allowance').slice(0, 120), item: String(a.item).slice(0, 500),
        per_unit_qty: num(a.per_unit_qty), unit: a.unit ? String(a.unit).slice(0, 20) : null, unit_count: int(a.unit_count),
        per_text: a.per_text ? String(a.per_text).slice(0, 120) : null, note_ref: a.note_ref ? String(a.note_ref).slice(0, 160) : null,
      }));
      if (allow.some((a) => Number.isNaN(a.per_unit_qty) || Number.isNaN(a.unit_count))) return err('bad allowance number');
      await upsertRead('allowances', ALLOW_COLS, 'allowance_key', allow, ALLOW_READ);
      res.allowances = allow.length;
      return ok(res);
    }

    // ── cable types ──
    if (b.action === 'set_cable') {
      const cur = await one('riser_cables', CABLE_COLS, 'note_number', b.note_number);
      if (!cur) return err('Cable type not found', 404);
      if (![null, 'isp', 'osp'].includes(b.isp_osp ?? null)) return err('isp_osp must be isp, osp or empty');
      return ok(await update('riser_cables', CABLE_COLS, cur.id, {
        isp_osp: b.isp_osp ?? null, source: 'edited', override_basis: String(b.basis || '').trim() || 'ISP/OSP set by user',
        original_value: cur.source === 'extracted' ? pick(cur, CABLE_READ) : cur.original_value, ...UNCONFIRM, ...stamp,
      }));
    }
    if (b.action === 'confirm_cable') {
      const cur = await one('riser_cables', CABLE_COLS, 'note_number', b.note_number);
      if (!cur) return err('Cable type not found', 404);
      if (b.confirmed !== false && cableBlocker(cur)) return err(`Note ${cur.note_number}: ${cableBlocker(cur)}`);
      return ok(await update('riser_cables', CABLE_COLS, cur.id, b.confirmed === false ? UNCONFIRM : { confirmed_at: now, confirmed_by: user.id }));
    }

    // ── feeds: scope and matching ──
    const feed = b.riser_key ? await one('riser_feeds', FEED_COLS, 'riser_key', b.riser_key) : null;
    const needFeed = ['set_match', 'accept_match', 'add_in', 'take_out', 'set_cores', 'confirm_feed'].includes(b.action);
    if (needFeed && !feed) return err('Riser TR not found', 404);
    const nameTaken = async (name, exceptId) => {
      const { data } = await db.from('riser_feeds').select('id, riser_key').eq('project_id', P).eq('tr_name', name);
      return (data || []).find((f) => f.id !== exceptId) || null;
    };

    if (b.action === 'set_match') {
      if (b.tr_name == null || b.tr_name === '') return ok(await update('riser_feeds', FEED_COLS, feed.id, { tr_name: null, match_kind: null, ...UNCONFIRM }));
      const trs = await trList();
      if (!trs.some((t) => t.tr_number === b.tr_name)) return err(`"${b.tr_name}" is not on the TR list`);
      const other = await nameTaken(b.tr_name, feed.id);
      if (other) return err(`${b.tr_name} is already matched to ${other.riser_key}`);
      return ok(await update('riser_feeds', FEED_COLS, feed.id, { tr_name: b.tr_name, match_kind: 'manual', suggested_tr: null, ...UNCONFIRM }));
    }
    if (b.action === 'accept_match') {
      if (!feed.suggested_tr) return err('No close match to accept');
      const other = await nameTaken(feed.suggested_tr, feed.id);
      if (other) return err(`${feed.suggested_tr} is already matched to ${other.riser_key}`);
      return ok(await update('riser_feeds', FEED_COLS, feed.id, { tr_name: feed.suggested_tr, match_kind: 'close', ...UNCONFIRM }));
    }
    if (b.action === 'add_in') {
      const name = String(b.tr_name || feed.tr_name_read || '').trim();
      if (!name) return err('This riser TR has no number — give it a name to add it in');
      if (name.length > 40) return err('TR name too long');
      const trs = await trList();
      if (trs.some((t) => t.tr_number === name)) return err(`${name} is already on the TR list — match it instead`);
      const other = await nameTaken(name, feed.id);
      if (other) return err(`${name} is already used by ${other.riser_key}`);
      const { error } = await db.from('trs').insert({
        org_id: orgId, project_id: P, tr_number: name, building: feed.building, level: feed.floor, source: 'manual',
        override_basis: `${ADDED_BASIS}: ${feed.riser_key}`, ...stamp,
      });
      if (error) return err(error.message, 500);
      return ok(await update('riser_feeds', FEED_COLS, feed.id, { tr_name: name, match_kind: 'added', suggested_tr: null, ...UNCONFIRM }));
    }
    if (b.action === 'take_out') {
      let removedTr = false;
      if (feed.match_kind === 'added' && feed.tr_name) {
        const { data: devs } = await db.from('tr_room_devices').select('id').eq('project_id', P).eq('tr_name', feed.tr_name).limit(1);
        if (!devs?.length) {
          const { error } = await db.from('trs').delete().eq('project_id', P).eq('tr_number', feed.tr_name).eq('source', 'manual').like('override_basis', `${ADDED_BASIS}%`);
          if (error) return err(error.message, 500);
          removedTr = true;
        }
      }
      const row = await update('riser_feeds', FEED_COLS, feed.id, { tr_name: null, match_kind: null, ...UNCONFIRM });
      return ok({ ...row, removed_tr: removedTr });
    }
    if (b.action === 'set_cores') {
      const a = int(b.core_a_note), c = int(b.core_b_note);
      if (Number.isNaN(a) || Number.isNaN(c)) return err('Core notes must be note numbers');
      return ok(await update('riser_feeds', FEED_COLS, feed.id, {
        core_a_note: a, core_b_note: c, core_a: a != null || feed.core_a, core_b: c != null || feed.core_b,
        source: 'edited', override_basis: String(b.basis || '').trim() || 'Core cable notes set by user',
        original_value: feed.source === 'extracted' ? pick(feed, FEED_READ) : feed.original_value, ...UNCONFIRM, ...stamp,
      }));
    }
    if (b.action === 'confirm_feed') {
      if (b.confirmed === false) return ok(await update('riser_feeds', FEED_COLS, feed.id, { ...UNCONFIRM, isp_osp: null }));
      const cables = await cablesNow();
      const why = feedBlocker(feed, cables);
      if (why) return err(`${feed.riser_key}: ${why}`);
      return ok(await update('riser_feeds', FEED_COLS, feed.id, { confirmed_at: now, confirmed_by: user.id, isp_osp: feedType(feed, cables, { confirmedOnly: true }).isp_osp }));
    }
    if (b.action === 'confirm_ready_feeds') {
      const cables = await cablesNow();
      const { data: all, error } = await db.from('riser_feeds').select(FEED_COLS).eq('project_id', P);
      if (error) return err(error.message, 500);
      let n = 0;
      for (const f of all.filter((x) => !x.confirmed_at && !feedBlocker(x, cables))) {
        await update('riser_feeds', 'id', f.id, { confirmed_at: now, confirmed_by: user.id, isp_osp: feedType(f, cables, { confirmedOnly: true }).isp_osp });
        n++;
      }
      return ok({ confirmed: n });
    }

    // ── allowances ──
    if (b.action === 'set_allowance') {
      const cur = await one('allowances', ALLOW_COLS, 'allowance_key', b.allowance_key);
      if (!cur) return err('Allowance line not found', 404);
      const p = b.patch || {};
      const patch = {};
      if ('item' in p) { if (!String(p.item || '').trim()) return err('Item cannot be empty'); patch.item = String(p.item).slice(0, 500); }
      if ('per_unit_qty' in p) { patch.per_unit_qty = num(p.per_unit_qty); if (Number.isNaN(patch.per_unit_qty)) return err('Quantity per unit must be 0 or more'); }
      if ('unit_count' in p) { patch.unit_count = int(p.unit_count); if (Number.isNaN(patch.unit_count)) return err('Unit count must be a whole number'); }
      if ('unit' in p) patch.unit = p.unit ? String(p.unit).slice(0, 20) : null;
      if ('per_text' in p) patch.per_text = p.per_text ? String(p.per_text).slice(0, 120) : null;
      return ok(await update('allowances', ALLOW_COLS, cur.id, {
        ...patch, source: 'edited', override_basis: String(b.basis || '').trim() || 'Allowance line edited by user',
        original_value: cur.source === 'extracted' ? pick(cur, ALLOW_READ) : cur.original_value, ...UNCONFIRM, ...stamp,
      }));
    }
    if (b.action === 'confirm_allowance') {
      const cur = await one('allowances', ALLOW_COLS, 'allowance_key', b.allowance_key);
      if (!cur) return err('Allowance line not found', 404);
      if (b.confirmed !== false && allowanceBlocker(cur)) return err(allowanceBlocker(cur));
      return ok(await update('allowances', ALLOW_COLS, cur.id, b.confirmed === false ? UNCONFIRM : { confirmed_at: now, confirmed_by: user.id }));
    }
    if (b.action === 'confirm_ready_allowances') {
      const { data: all, error } = await db.from('allowances').select(ALLOW_COLS).eq('project_id', P);
      if (error) return err(error.message, 500);
      const ready = all.filter((a) => !a.confirmed_at && !a.conflict && !allowanceBlocker(a));
      if (ready.length) { const { error: e } = await db.from('allowances').update({ confirmed_at: now, confirmed_by: user.id }).in('id', ready.map((a) => a.id)); if (e) return err(e.message, 500); }
      return ok({ confirmed: ready.length });
    }

    return err('Unknown action');
  } catch (e) {
    return err(e.message, 500);
  }
}

export const config = { path: '/api/wf/wf7/riser' };
