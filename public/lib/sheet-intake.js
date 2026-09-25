// public/lib/sheet-intake.js
// Decides what an incoming page is, relative to the sheets already in the
// project. Pure — the API applies the result to the database.
//
// A sheet is identified by its sheet number; every upload of it is a revision.
// Nothing silently replaces anything: a new revision starts PENDING until the
// user accepts it, and the pinned reference is never touched here.
// ─────────────────────────────────────────────────────────────────

import { STEPS } from './wf-steps.js';

// incoming: { sheet_number, rev_label (null if not printed), content_hash }
// existing: null, or { sheet_id, revisions: [{ id, rev_label, content_hash, status }] }
// uploadTag: short unique text for this upload (e.g. the document id)
export function classifyIncoming(incoming, existing, uploadTag) {
  const { sheet_number, rev_label, content_hash } = incoming;

  if (!sheet_number) return { kind: 'unnumbered' };

  if (!existing) {
    return { kind: 'new_sheet', rev_label: rev_label || 'Rev.0', rev_assumed: !rev_label, status: 'accepted' };
  }

  const revs = existing.revisions || [];
  const same = revs.find((r) => r.content_hash && r.content_hash === content_hash && r.status !== 'rejected');
  if (same) return { kind: 'duplicate', of_revision_id: same.id };

  if (rev_label && revs.some((r) => r.rev_label === rev_label)) {
    // Two different pages both claim to be the same sheet and revision.
    return { kind: 'conflict', rev_label: `${rev_label} (alt ${uploadTag})`, rev_assumed: false, status: 'pending' };
  }
  if (rev_label) return { kind: 'new_revision', rev_label, rev_assumed: false, status: 'pending' };

  // Changed content with no revision printed.
  return { kind: 'new_revision', rev_label: `Unlabelled ${uploadTag}`, rev_assumed: true, status: 'pending' };
}

// Which step owns a page, from its role. Pages move between steps by role.
export function stepForRole(role) {
  if (!role || role === 'skip') return null;
  const s = STEPS.find((st) => st.roles.includes(role));
  return s ? s.code : null;
}

export const ALL_ROLES = ['legend', 'notes', 'schedule', 'osp_route', 'osp_overview', 'plan', 'key_plan',
  'tr_room', 'rack', 'detail', 'riser', 'skip'];

// Human text for the decisions bar.
export function decisionText(d) {
  switch (d.kind) {
    case 'new_revision':
      return d.rev_assumed
        ? `${d.sheet_number} changed but shows no revision number. Treat it as a new revision?`
        : `${d.sheet_number} ${d.rev_label} replaces ${d.current_label || 'the current revision'}. The reference stays pinned.`;
    case 'conflict':
      return `Two different pages both claim to be ${d.sheet_number} ${d.base_label || ''}. Keep which one?`;
    case 'move':
      return `${d.sheet_number || 'Page ' + d.page_number} reads as ${d.role} — that belongs in ${d.step_code}.`;
    case 'unnumbered':
      return `Page ${d.page_number} of ${d.filename} has no readable sheet number.`;
    default:
      return '';
  }
}
