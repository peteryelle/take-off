// netlify/functions/wf-documents.js
// v2 intake: files, pages, sheets and revisions (takeoff schema).
//
// GET  /api/wf/documents?project_id=1                → files, pages (with sheet + revision), pending decisions
// POST /api/wf/documents { action: "begin_upload", project_id, step_code, filename }
//        → creates the document row, returns a signed upload URL. Storage path:
//          schematics/v2/{project_id}/{document_id}-{filename}  (never overwrites)
// POST { action: "register_pages", document_id, page_count, pages: [...] }
//        → pages read in the browser (title block, hash); files them as sheets/revisions
// POST { action: "fail_upload", document_id, error }
// POST { action: "set_page", page_id, role?, building?, level?, zone? }
// POST { action: "decide_revision", revision_id, accept }
// POST { action: "pin_reference", project_id, step_code? }   (omit step_code = whole project)
// POST { action: "file_url", document_id }                  → signed download URL
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { classifyIncoming, stepForRole, ALL_ROLES } from '../../public/lib/sheet-intake.js';
import { STEP_CODES } from '../../public/lib/wf-steps.js';

const BUCKET = 'schematics';
const UPLOAD_TTL = 300;
const DOWNLOAD_TTL = 3600;

const safeName = (n) => String(n || 'file.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, user } = gate;
  const db = td(supabase);

  if (req.method === 'GET') {
    const projectId = new URL(req.url).searchParams.get('project_id');
    if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);
    return ok(await loadIntake(db, projectId));
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let b;
  try { b = await req.json(); } catch { return err('Invalid JSON'); }

  // Resolve + authorize the project for every action.
  let projectId = b.project_id;
  if (!projectId && b.document_id) projectId = (await one(db, 'documents', b.document_id, 'project_id'))?.project_id;
  if (!projectId && b.page_id) projectId = (await one(db, 'pages', b.page_id, 'project_id'))?.project_id;
  if (!projectId && b.revision_id) {
    const rev = await one(db, 'sheet_revisions', b.revision_id, 'sheet_id');
    if (rev) projectId = (await one(db, 'sheets', rev.sheet_id, 'project_id'))?.project_id;
  }
  if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);

  try {
    switch (b.action) {
      case 'begin_upload': return await beginUpload(supabase, db, orgId, user, projectId, b);
      case 'register_pages': return await registerPages(db, orgId, user, projectId, b);
      case 'fail_upload': {
        await db.from('documents').update({ status: 'failed', error: String(b.error || 'failed').slice(0, 500) }).eq('id', b.document_id);
        return ok({ ok: true });
      }
      case 'set_page': return await setPage(db, b);
      case 'decide_revision': return await decideRevision(db, user, b);
      case 'pin_reference': return await pinReference(db, projectId, b.step_code);
      case 'file_url': {
        const doc = await one(db, 'documents', b.document_id, 'storage_path, filename');
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, DOWNLOAD_TTL);
        if (error) return err(error.message, 500);
        return ok({ url: data.signedUrl, filename: doc.filename });
      }
      default: return err('Unknown action');
    }
  } catch (e) {
    return err(e.message || String(e), 500);
  }
}

async function one(db, table, id, cols) {
  if (!id) return null;
  const { data } = await db.from(table).select(cols).eq('id', id).maybeSingle();
  return data;
}

async function beginUpload(supabase, db, orgId, user, projectId, b) {
  if (!STEP_CODES.includes(b.step_code) || b.step_code === 'WF8') return err('step_code must be WF1–WF7');
  const filename = safeName(b.filename);
  if (!/\.pdf$/i.test(filename)) return err('Only PDF files for now');

  const { data: doc, error } = await db.from('documents').insert({
    org_id: orgId, project_id: projectId, step_code: b.step_code,
    filename, storage_path: 'pending', uploaded_by: user.id,
  }).select('id').single();
  if (error) return err(error.message, 500);

  const path = `v2/${projectId}/${doc.id}-${filename}`;
  const { data: signed, error: sErr } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (sErr) {
    await db.from('documents').update({ status: 'failed', error: sErr.message }).eq('id', doc.id);
    return err(sErr.message, 500);
  }
  await db.from('documents').update({ storage_path: path }).eq('id', doc.id);
  return ok({ document_id: doc.id, url: signed.signedUrl, path, expires_in: UPLOAD_TTL });
}

// Pages arrive already read in the browser (title block + text hash).
async function registerPages(db, orgId, user, projectId, b) {
  const doc = await one(db, 'documents', b.document_id, 'id, step_code, filename, status');
  if (!doc) return err('Document not found', 404);
  if (doc.status === 'indexed') return err('Pages already registered for this file');
  const pages = Array.isArray(b.pages) ? b.pages : [];
  if (!pages.length) return err('No pages');

  // Existing sheets + their revisions' content hashes, once.
  const { data: sheetRows, error: shErr } = await db.from('sheets')
    .select('id, sheet_number, current_revision_id, sheet_revisions!sheet_revisions_sheet_id_fkey(id, rev_label, status, pages!sheet_revisions_page_id_fkey(content_hash))')
    .eq('project_id', projectId);
  if (shErr) return err(shErr.message, 500);
  const sheets = new Map((sheetRows || []).map((s) => [s.sheet_number, {
    sheet_id: s.id, current_revision_id: s.current_revision_id,
    revisions: (s.sheet_revisions || []).map((r) => ({ id: r.id, rev_label: r.rev_label, status: r.status, content_hash: r.pages?.content_hash })),
  }]));

  // One rule per distinct kind + value + step: the same note is printed on
  // every floor plan, and it should appear once (credited to the first sheet).
  const ruleKey = (r) => `${r.rule_kind}|${r.rule_value ?? ''}|${r.used_by_step ?? ''}|${r.rule_kind === 'phasing' ? r.note_ref : ''}`;
  const { data: ruleRows } = await db.from('project_notes').select('note_ref, rule_kind, rule_value, used_by_step').eq('project_id', projectId);
  const ruleKeys = new Set((ruleRows || []).map(ruleKey));
  const addRules = async (p, pageId, revisionId) => {
    for (const r of Array.isArray(p.rules) ? p.rules : []) {
      const key = ruleKey({ ...r, rule_value: r.rule_value == null ? null : Number(r.rule_value) });
      if (ruleKeys.has(key) || !['pull_limit_ft', 'bend_limit_deg', 'phasing', 'other'].includes(r.rule_kind)) continue;
      const { error } = await db.from('project_notes').insert({
        org_id: orgId, project_id: projectId, page_id: pageId, sheet_revision_id: revisionId,
        note_ref: r.note_ref || null, note_text: String(r.note_text || '').slice(0, 2000) || String(r.note_ref),
        rule_kind: r.rule_kind, rule_value: Number.isFinite(Number(r.rule_value)) && r.rule_value !== null ? Number(r.rule_value) : null,
        used_by_step: r.used_by_step || null, source: 'extracted',
      });
      if (!error) { ruleKeys.add(key); summary.rules++; }
    }
  };

  const summary = { new_sheets: 0, duplicates: 0, pending_revisions: 0, conflicts: 0, unnumbered: 0, moved: 0, rules: 0 };
  for (const p of pages) {
    const role = ALL_ROLES.includes(p.suggested_role) ? p.suggested_role : null;
    const { data: page, error: pErr } = await db.from('pages').insert({
      org_id: orgId, project_id: projectId, document_id: doc.id, page_number: p.page_number,
      content_hash: p.content_hash || null, title_text: p.title || null,
      role, role_source: role ? 'suggested' : null,
      building: p.building || null, level: p.level || null, zone: p.zone || null,
    }).select('id').single();
    if (pErr) return err(`Page ${p.page_number}: ${pErr.message}`, 500);

    const sheetNo = p.sheet_number ? String(p.sheet_number).trim().toUpperCase() : null;
    const existing = sheetNo ? sheets.get(sheetNo) || null : null;
    const d = classifyIncoming({ sheet_number: sheetNo, rev_label: p.rev_label || null, content_hash: p.content_hash }, existing, `d${doc.id}p${p.page_number}`);
    if (role && stepForRole(role) && stepForRole(role) !== doc.step_code) summary.moved++;

    if (d.kind === 'unnumbered') { summary.unnumbered++; await addRules(p, page.id, null); continue; }

    if (d.kind === 'duplicate') {
      await db.from('pages').update({ is_duplicate: true, sheet_id: existing.sheet_id }).eq('id', page.id);
      summary.duplicates++;
      continue;
    }

    let sheetId = existing?.sheet_id;
    if (!sheetId) {
      const { data: s, error: sErr } = await db.from('sheets').insert({
        org_id: orgId, project_id: projectId, sheet_number: sheetNo, title: p.title || null, step_code: stepForRole(role),
      }).select('id').single();
      if (sErr) return err(`Sheet ${sheetNo}: ${sErr.message}`, 500);
      sheetId = s.id;
    }
    const { data: rev, error: rErr } = await db.from('sheet_revisions').insert({
      org_id: orgId, sheet_id: sheetId, rev_label: d.rev_label, page_id: page.id, status: d.status,
      accepted_at: d.status === 'accepted' ? new Date().toISOString() : null,
      accepted_by: d.status === 'accepted' ? user.id : null,
    }).select('id').single();
    if (rErr) return err(`Revision ${sheetNo} ${d.rev_label}: ${rErr.message}`, 500);
    await db.from('pages').update({ sheet_id: sheetId }).eq('id', page.id);
    await addRules(p, page.id, rev.id);

    if (d.kind === 'new_sheet') {
      await db.from('sheets').update({ current_revision_id: rev.id }).eq('id', sheetId);
      sheets.set(sheetNo, { sheet_id: sheetId, current_revision_id: rev.id, revisions: [{ id: rev.id, rev_label: d.rev_label, status: 'accepted', content_hash: p.content_hash }] });
      summary.new_sheets++;
    } else {
      existing.revisions.push({ id: rev.id, rev_label: d.rev_label, status: 'pending', content_hash: p.content_hash });
      if (d.kind === 'conflict') summary.conflicts++; else summary.pending_revisions++;
    }
  }

  await db.from('documents').update({ status: 'indexed', page_count: b.page_count || pages.length, error: null }).eq('id', doc.id);
  return ok({ document_id: doc.id, pages: pages.length, ...summary });
}

async function setPage(db, b) {
  const patch = {};
  if ('role' in b) {
    if (b.role !== null && !ALL_ROLES.includes(b.role)) return err('Unknown role');
    patch.role = b.role; patch.role_source = 'user';
  }
  for (const k of ['building', 'level', 'zone']) if (k in b) patch[k] = b[k] === '' ? null : b[k];
  if (!Object.keys(patch).length) return err('Nothing to change');
  const { data, error } = await db.from('pages').update(patch).eq('id', b.page_id)
    .select('id, role, role_source, building, level, zone, sheet_id').single();
  if (error) return err(error.message, 500);
  // Keep the sheet's owning step in line with its role.
  if ('role' in patch && data.sheet_id) await db.from('sheets').update({ step_code: stepForRole(patch.role) }).eq('id', data.sheet_id);
  return ok(data);
}

async function decideRevision(db, user, b) {
  const rev = await one(db, 'sheet_revisions', b.revision_id, 'id, sheet_id, rev_label, status');
  if (!rev) return err('Revision not found', 404);
  if (rev.status !== 'pending') return err(`Revision is already ${rev.status}`);

  if (!b.accept) {
    await db.from('sheet_revisions').update({ status: 'rejected' }).eq('id', rev.id);
    return ok({ status: 'rejected' });
  }
  const sheet = await one(db, 'sheets', rev.sheet_id, 'id, project_id, sheet_number, current_revision_id, step_code');
  await db.from('sheet_revisions').update({ status: 'accepted', accepted_at: new Date().toISOString(), accepted_by: user.id }).eq('id', rev.id);
  if (sheet.current_revision_id) await db.from('sheet_revisions').update({ superseded_by: rev.id }).eq('id', sheet.current_revision_id);
  await db.from('sheets').update({ current_revision_id: rev.id }).eq('id', sheet.id);

  // A confirmed step that owns this sheet now needs review.
  if (sheet.step_code) {
    await db.from('workflow_steps')
      .update({ status: 'stale', stale_reason: `${sheet.sheet_number} ${rev.rev_label} accepted` })
      .eq('project_id', sheet.project_id).eq('step_code', sheet.step_code).eq('status', 'confirmed');
  }
  return ok({ status: 'accepted', sheet_number: sheet.sheet_number });
}

// Pin the current revision of every sheet (optionally one step's) as the reference.
async function pinReference(db, projectId, stepCode) {
  let q = db.from('sheets').select('id, current_revision_id').eq('project_id', projectId).not('current_revision_id', 'is', null);
  if (stepCode) q = q.eq('step_code', stepCode);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  for (const s of data || []) await db.from('sheets').update({ reference_revision_id: s.current_revision_id }).eq('id', s.id);
  return ok({ pinned: (data || []).length });
}

// Everything a step page needs, for the whole project (steps filter client-side).
async function loadIntake(db, projectId) {
  const [docs, pages, revs] = await Promise.all([
    db.from('documents').select('id, step_code, filename, page_count, status, error, uploaded_at').eq('project_id', projectId).order('uploaded_at'),
    db.from('pages').select('id, document_id, page_number, sheet_id, title_text, role, role_source, building, level, zone, is_duplicate, content_hash')
      .eq('project_id', projectId).order('document_id').order('page_number'),
    db.from('sheets').select('id, sheet_number, title, step_code, reference_revision_id, current_revision_id, sheet_revisions!sheet_revisions_sheet_id_fkey(id, rev_label, status, page_id)')
      .eq('project_id', projectId),
  ]);
  for (const r of [docs, pages, revs]) if (r.error) throw new Error(r.error.message);

  const sheetById = new Map((revs.data || []).map((s) => [s.id, s]));
  const revByPage = new Map();
  const pending = [];
  for (const s of revs.data || []) {
    const current = (s.sheet_revisions || []).find((r) => r.id === s.current_revision_id);
    for (const r of s.sheet_revisions || []) {
      revByPage.set(r.page_id, { ...r, is_current: r.id === s.current_revision_id, is_reference: r.id === s.reference_revision_id });
      if (r.status === 'pending') pending.push({
        revision_id: r.id, page_id: r.page_id, sheet_number: s.sheet_number, rev_label: r.rev_label,
        current_label: current?.rev_label || null, kind: /\(alt /.test(r.rev_label) ? 'conflict' : 'new_revision',
        rev_assumed: /^Unlabelled /.test(r.rev_label), step_code: s.step_code,
      });
    }
  }
  const docName = new Map((docs.data || []).map((d) => [d.id, d.filename]));
  const outPages = (pages.data || []).map((p) => {
    const s = p.sheet_id ? sheetById.get(p.sheet_id) : null;
    return {
      ...p, filename: docName.get(p.document_id),
      sheet_number: s?.sheet_number || null, step_code: stepForRole(p.role),
      revision: revByPage.get(p.id) || null,
    };
  });
  return { documents: docs.data || [], pages: outPages, pending };
}

export const config = { path: '/api/wf/documents' };
