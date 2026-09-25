// netlify/functions/wf-wf1.js
// WF1 · Legend & notes data.
//
// GET  /api/wf/wf1?project_id=1                    → { line_types, rules }
// POST { action: "save_line_types", project_id, rows: [{ line_style, line_meaning }] }
// POST { action: "save_rules", project_id, rows: [{ id?, note_ref, note_text, rule_kind, rule_value, used_by_step }] }
//
// Rules found in the notes at upload time are stored as source "extracted";
// anything typed or changed here becomes "edited"/"manual" with a reason, per
// the provenance rule (the database refuses an edit without one).
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';

const MEANINGS = ['new_route', 'existing_route', 'tunnel', 'ignore'];
const KINDS = ['pull_limit_ft', 'bend_limit_deg', 'phasing', 'other'];
const STEPS = ['WF3', 'WF4', 'WF5', 'WF6', 'WF7', 'WF8'];

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const projectId = new URL(req.url).searchParams.get('project_id');
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    const [lines, rules] = await Promise.all([
      db.from('legend_entries').select('id, line_style, line_meaning, source').eq('project_id', projectId).not('line_meaning', 'is', null).order('id'),
      db.from('project_notes').select('id, page_id, note_ref, note_text, rule_kind, rule_value, used_by_step, source, override_basis').eq('project_id', projectId).order('id'),
    ]);
    if (lines.error) return err(lines.error.message, 500);
    if (rules.error) return err(rules.error.message, 500);
    return ok({ line_types: lines.data, rules: rules.data });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let b;
  try { b = await req.json(); } catch { return err('Invalid JSON'); }
  if (!(await assertWfProjectInOrg(supabase, b.project_id, orgId))) return err('Project not found', 404);
  const rows = Array.isArray(b.rows) ? b.rows : [];

  if (b.action === 'save_line_types') {
    for (const r of rows) if (!MEANINGS.includes(r.line_meaning) || !String(r.line_style || '').trim()) return err('Each line type needs a style and a meaning');
    const del = await db.from('legend_entries').delete().eq('project_id', b.project_id).not('line_meaning', 'is', null);
    if (del.error) return err(del.error.message, 500);
    if (rows.length) {
      const ins = await db.from('legend_entries').insert(rows.map((r) => ({
        org_id: orgId, project_id: b.project_id,
        line_style: String(r.line_style).trim().slice(0, 80), line_meaning: r.line_meaning,
        source: 'manual', override_basis: 'Set in WF1 from the legend', entered_by: user.id,
      })));
      if (ins.error) return err(ins.error.message, 500);
    }
    return ok({ saved: rows.length });
  }

  if (b.action === 'save_rules') {
    const { data: existing, error: exErr } = await db.from('project_notes')
      .select('id, note_text, rule_kind, rule_value, used_by_step, source').eq('project_id', b.project_id);
    if (exErr) return err(exErr.message, 500);
    const byId = new Map((existing || []).map((r) => [r.id, r]));
    const keep = new Set();

    for (const r of rows) {
      if (!KINDS.includes(r.rule_kind)) return err('Unknown rule kind');
      if (r.used_by_step && !STEPS.includes(r.used_by_step)) return err('Unknown step');
      const value = r.rule_value === '' || r.rule_value == null ? null : Number(r.rule_value);
      if (value !== null && !Number.isFinite(value)) return err('Rule value must be a number');
      const prev = r.id ? byId.get(r.id) : null;

      if (prev) {
        keep.add(prev.id);
        const changed = prev.rule_value !== value || prev.used_by_step !== (r.used_by_step || null) || prev.rule_kind !== r.rule_kind;
        if (!changed) continue;
        const up = await db.from('project_notes').update({
          rule_kind: r.rule_kind, rule_value: value, used_by_step: r.used_by_step || null,
          source: prev.source === 'extracted' ? 'edited' : prev.source,
          original_value: prev.source === 'extracted' ? { rule_kind: prev.rule_kind, rule_value: prev.rule_value, used_by_step: prev.used_by_step } : undefined,
          override_basis: String(r.override_basis || 'Changed in WF1').slice(0, 300), entered_by: user.id, entered_at: new Date().toISOString(),
        }).eq('id', prev.id);
        if (up.error) return err(up.error.message, 500);
      } else {
        const ins = await db.from('project_notes').insert({
          org_id: orgId, project_id: b.project_id, note_ref: r.note_ref || null,
          note_text: String(r.note_text || r.note_ref || 'Rule entered in WF1').slice(0, 2000),
          rule_kind: r.rule_kind, rule_value: value, used_by_step: r.used_by_step || null,
          source: 'manual', override_basis: String(r.override_basis || 'Entered in WF1').slice(0, 300), entered_by: user.id,
        }).select('id').single();
        if (ins.error) return err(ins.error.message, 500);
        keep.add(ins.data.id);
      }
    }
    const drop = (existing || []).filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (drop.length) {
      const del = await db.from('project_notes').delete().in('id', drop);
      if (del.error) return err(del.error.message, 500);
    }
    return ok({ saved: keep.size, removed: drop.length });
  }

  return err('Unknown action');
}

export const config = { path: '/api/wf/wf1' };
