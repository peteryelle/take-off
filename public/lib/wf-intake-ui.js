// public/lib/wf-intake-ui.js
// Shared intake for every workflow step: "+ Add PDFs", per-file progress,
// the decisions bar, and the sheet table. Browser-only.
//
// PDFs are read HERE, in the browser, from the text layer (no cost): title
// block, suggested role, location, a text fingerprint, and any pull/bend/
// phasing rules in the notes. Only the results go to the API; the file itself
// goes straight to Storage through a signed URL (never through a function).
//
// Requires pdf.js 3.11.174 loaded as the global `pdfjsLib` by the page.
// ─────────────────────────────────────────────────────────────────

import { readTitleBlock, pageTextKey } from './title-block.js';
import { findRules, findPhasingSheetRefs } from './note-rules.js';
import { ALL_ROLES, stepForRole } from './sheet-intake.js';
import { stepDef } from './wf-steps.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE_LABEL = { osp_route: 'osp route', osp_overview: 'osp overview', key_plan: 'key plan', tr_room: 'tr room' };
const roleLabel = (r) => (r ? ROLE_LABEL[r] || r : '—');

export async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
export const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Read every page of a PDF from its text layer.
export async function readPdf(file, onPage) {
  if (!window.pdfjsLib) throw new Error('PDF reader not loaded');
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({
      s: i.str, x: i.transform[4] / vp.width, y: 1 - i.transform[5] / vp.height, h: Math.hypot(i.transform[2], i.transform[3]),
    }));
    const tb = readTitleBlock(items, file.name);
    const text = tc.items.map((i) => i.str).join(' ');
    const rules = findRules(text, tb.sheet_number);
    for (const ref of findPhasingSheetRefs(text)) {
      rules.push({
        note_ref: `${tb.sheet_number || 'page ' + n} → ${ref}`, rule_kind: 'phasing', rule_value: null, used_by_step: 'WF8',
        note_text: `${tb.sheet_number || 'This sheet'} refers to ${ref} for general and phasing notes.`,
      });
    }
    pages.push({ page_number: n, ...tb, content_hash: await sha256(pageTextKey(items)), rules });
    page.cleanup();
    onPage?.(n, doc.numPages);
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pageCount, pages };
}

// Mount the intake block for one step.
//   el: container   opts: { projectId, stepCode, showLocation, onData(intake) }
export function mountIntake(el, opts) {
  const { projectId, stepCode } = opts;
  const state = { intake: null, uploads: [] };

  el.innerHTML = `
    <section class="panel" aria-label="Sheets in this step">
      <div class="row" style="justify-content: space-between">
        <div><div style="font-size: 12px; color: var(--muted); letter-spacing: .08em">SHEETS IN THIS STEP</div>
          <div class="wf-sub" data-el="count" style="margin-top: 4px"></div></div>
        <div style="display: flex; gap: 8px">
          <button type="button" class="btn muted small" data-el="pin" title="Save the current revision of every sheet in this step as the reference for comparisons and change orders">Pin current as reference</button>
          <label class="btn green">+ Add PDFs<input type="file" accept="application/pdf,.pdf" multiple hidden data-el="file"></label>
        </div>
      </div>
      <div data-el="uploads"></div>
    </section>
    <section class="banner amber" data-el="decisions" hidden></section>
    <section class="panel" data-el="table" aria-label="Sheet list"></section>
    <div class="status-line" data-el="status" role="status"></div>`;
  const $ = (k) => el.querySelector(`[data-el="${k}"]`);
  const setStatus = (msg, cls = '') => { $('status').className = 'status-line ' + cls; $('status').textContent = msg; };

  $('file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) state.uploads.push({ file: f, status: 'waiting', note: '' });
    renderUploads();
    for (const u of state.uploads.filter((x) => x.status === 'waiting')) await uploadOne(u);
    await reload();
  });

  $('pin').addEventListener('click', async () => {
    if (!confirm(`Pin the current revision of every ${stepCode} sheet as the reference? Change orders compare against the reference.`)) return;
    try {
      const r = await post('/api/wf/documents', { action: 'pin_reference', project_id: projectId, step_code: stepCode });
      setStatus(`Reference pinned for ${r.pinned} sheet${r.pinned === 1 ? '' : 's'}.`, 'ok');
      await reload();
    } catch (err) { setStatus(err.message, 'err'); }
  });

  async function uploadOne(u) {
    let docId = null;
    try {
      u.status = 'reading'; u.note = 'reading pages…'; renderUploads();
      const read = await readPdf(u.file, (n, total) => { u.note = `reading page ${n} of ${total}…`; renderUploads(); });
      u.status = 'uploading'; u.note = `${read.pageCount} pages · uploading…`; renderUploads();
      const begin = await post('/api/wf/documents', { action: 'begin_upload', project_id: projectId, step_code: stepCode, filename: u.file.name });
      docId = begin.document_id;
      const put = await fetch(begin.url, { method: 'PUT', body: u.file, headers: { 'Content-Type': 'application/pdf' } });
      if (!put.ok) throw new Error(`Storage upload failed (${put.status})`);
      u.note = `${read.pageCount} pages · filing sheets…`; renderUploads();
      const r = await post('/api/wf/documents', { action: 'register_pages', document_id: docId, page_count: read.pageCount, pages: read.pages });
      await post('/api/wf/projects', { action: 'touch_step', project_id: projectId, step_code: stepCode }).catch(() => {});
      u.status = 'done';
      u.note = [
        `${r.pages} pages`,
        r.new_sheets && `${r.new_sheets} new sheet${r.new_sheets === 1 ? '' : 's'}`,
        r.duplicates && `${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}`,
        (r.pending_revisions + r.conflicts) && `${r.pending_revisions + r.conflicts} to decide`,
        r.moved && `${r.moved} belong to other steps`,
        r.rules && `${r.rules} rule${r.rules === 1 ? '' : 's'} found`,
      ].filter(Boolean).join(' · ');
    } catch (err) {
      u.status = 'failed'; u.note = err.message;
      if (docId) post('/api/wf/documents', { action: 'fail_upload', document_id: docId, error: err.message }).catch(() => {});
    }
    renderUploads();
  }

  function renderUploads() {
    const pill = { waiting: 'open', reading: 'in_review', uploading: 'in_review', done: 'confirmed', failed: 'stale' };
    $('uploads').innerHTML = state.uploads.map((u) => `
      <div class="row" style="font-size: 13px">
        <span style="width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${esc(u.file.name)}</span>
        <span class="pill ${pill[u.status]}">${u.status}</span>
        <span class="muted" style="flex-grow: 1; ${u.status === 'failed' ? 'color: var(--red)' : ''}">${esc(u.note)}</span>
      </div>`).join('');
  }

  async function reload() {
    try {
      state.intake = await api('/api/wf/documents?project_id=' + encodeURIComponent(projectId));
      render();
      opts.onData?.(state.intake);
    } catch (err) { setStatus(err.message, 'err'); }
  }

  function render() {
    const { documents, pages, pending } = state.intake;
    const myDocs = new Set(documents.filter((d) => d.step_code === stepCode).map((d) => d.id));
    const mine = pages.filter((p) => p.step_code === stepCode || (myDocs.has(p.document_id) && !p.role));
    const elsewhere = pages.filter((p) => myDocs.has(p.document_id) && p.role && p.step_code !== stepCode && p.role !== 'skip');
    const unnumbered = pages.filter((p) => myDocs.has(p.document_id) && !p.sheet_number && !p.is_duplicate);
    const myPending = pending.filter((d) => d.step_code === stepCode || mine.some((p) => p.id === d.page_id));

    const sheets = new Set(mine.filter((p) => p.sheet_number && !p.is_duplicate).map((p) => p.sheet_number));
    $('count').textContent = `${sheets.size} sheet${sheets.size === 1 ? '' : 's'} · ${myDocs.size} file${myDocs.size === 1 ? '' : 's'} uploaded here`;

    // Decisions
    const items = [
      ...myPending.map((d) => `
        <div class="row" style="border-color: var(--amber-bd)">
          <span style="flex-grow: 1">${d.kind === 'conflict'
            ? `Two different pages both claim to be <b>${esc(d.sheet_number)}</b>. Keep this one (${esc(d.rev_label)})?`
            : d.rev_assumed
              ? `<b>${esc(d.sheet_number)}</b> changed but shows no revision number. Treat it as a new revision?`
              : `<b>${esc(d.sheet_number)} ${esc(d.rev_label)}</b> replaces ${esc(d.current_label || 'the current revision')}. The reference stays pinned.`}</span>
          <button type="button" class="btn green small" data-rev="${d.revision_id}" data-accept="1">Accept</button>
          <button type="button" class="btn muted small" data-rev="${d.revision_id}" data-accept="0">Reject</button>
        </div>`),
      ...elsewhere.map((p) => `
        <div class="row" style="border-color: var(--amber-bd)">
          <span style="flex-grow: 1">${esc(p.sheet_number || 'Page ' + p.page_number)} (${esc(p.filename)} p${p.page_number}) reads as <b>${esc(roleLabel(p.role))}</b>, so it appears in ${p.step_code} · ${esc(stepDef(p.step_code)?.name || '')}.</span>
          ${roleSelect(p, 'Change role')}
        </div>`),
      ...unnumbered.map((p) => `
        <div class="row" style="border-color: var(--amber-bd)">
          <span style="flex-grow: 1">Page ${p.page_number} of ${esc(p.filename)} has no readable sheet number. Set its role, or mark it skip.</span>
          ${roleSelect(p, 'Role')}
        </div>`),
    ];
    $('decisions').hidden = !items.length;
    $('decisions').style.display = items.length ? 'block' : 'none';
    $('decisions').innerHTML = items.length
      ? `<div class="kicker" style="padding: 0 0 8px">NEEDS YOUR DECISION (${items.length})</div>${items.join('')}`
      : '';

    // Table
    const loc = opts.showLocation;
    if (!mine.length) {
      $('table').innerHTML = `<div class="empty">No sheets yet. Use <b>+ Add PDFs</b> to upload this step's drawings — several files at once is fine.</div>`;
    } else {
      $('table').innerHTML = `
        <div class="row head">
          <span style="width: 110px">Sheet</span><span style="flex-grow: 1">Title</span>
          <span style="width: 200px">Source · pg</span><span style="width: 150px">Role</span>
          ${loc ? '<span style="width: 90px">Bldg</span><span style="width: 56px">Lvl</span><span style="width: 70px">Zone</span>' : ''}
          <span style="width: 150px">Revision</span>
        </div>
        ${mine.map((p) => rowHtml(p, loc)).join('')}`;
    }
    wire();
  }

  function roleSelect(p, label) {
    return `<label class="muted" style="font-size: 12px; display: flex; gap: 6px; align-items: center">${label}
      <select class="field" style="padding: 5px 6px; font-size: 12px" data-role="${p.id}" aria-label="Role for ${esc(p.sheet_number || 'page ' + p.page_number)}">
        <option value="">—</option>${ALL_ROLES.map((r) => `<option value="${r}"${r === p.role ? ' selected' : ''}>${roleLabel(r)}${stepForRole(r) ? ' · ' + stepForRole(r) : ''}</option>`).join('')}
      </select></label>`;
  }

  function rowHtml(p, loc) {
    const r = p.revision;
    let rev = '<span class="muted">—</span>';
    if (p.is_duplicate) rev = '<span class="pill open">duplicate</span>';
    else if (r) {
      const tag = r.status === 'pending' ? '<span class="pill stale">to decide</span>'
        : r.status === 'rejected' ? '<span class="pill open">rejected</span>'
        : r.is_current ? '' : '<span class="pill open">superseded</span>';
      rev = `${esc(r.rev_label)} ${r.is_reference ? '<span style="color: var(--green)" title="Pinned reference">● ref</span>' : ''} ${tag}`;
    }
    const cell = (k, w) => `<input class="field" style="width: ${w}px; padding: 5px 6px; font-size: 12px${!p[k] && p.role === 'plan' && k === 'zone' ? '; border-color: var(--orange-bd); background: var(--orange-bg)' : ''}" value="${esc(p[k] || '')}" data-loc="${k}" data-page="${p.id}" aria-label="${k}">`;
    return `
      <div class="row" style="font-size: 13px${p.is_duplicate ? '; opacity: .55' : ''}">
        <span style="width: 110px; font-weight: 700">${esc(p.sheet_number || '—')}</span>
        <span style="flex-grow: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="${esc(p.title_text || '')}">${esc(p.title_text || '')}</span>
        <span class="muted" style="width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="${esc(p.filename)}">${esc(p.filename)} · ${p.page_number}</span>
        <span style="width: 150px">${roleSelect(p, '').replace('<label class="muted" style="font-size: 12px; display: flex; gap: 6px; align-items: center">', '<label style="display: flex">')}</span>
        ${loc ? `<span style="width: 90px">${cell('building', 82)}</span><span style="width: 56px">${cell('level', 48)}</span><span style="width: 70px">${cell('zone', 62)}</span>` : ''}
        <span style="width: 150px">${rev}</span>
      </div>`;
  }

  function wire() {
    el.querySelectorAll('[data-rev]').forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await post('/api/wf/documents', { action: 'decide_revision', revision_id: Number(b.dataset.rev), accept: b.dataset.accept === '1' }); await reload(); }
      catch (err) { setStatus(err.message, 'err'); b.disabled = false; }
    });
    el.querySelectorAll('[data-role]').forEach((s) => s.onchange = async () => {
      try { await post('/api/wf/documents', { action: 'set_page', page_id: Number(s.dataset.role), role: s.value || null }); await reload(); }
      catch (err) { setStatus(err.message, 'err'); }
    });
    el.querySelectorAll('[data-loc]').forEach((i) => i.onchange = async () => {
      try { await post('/api/wf/documents', { action: 'set_page', page_id: Number(i.dataset.page), [i.dataset.loc]: i.value.trim() }); setStatus('Saved.', 'ok'); }
      catch (err) { setStatus(err.message, 'err'); }
    });
  }

  reload();
  return { reload, get intake() { return state.intake; } };
}
