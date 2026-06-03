// plan-set.js — pure set-level orchestration for drawing-set ingestion.
// No PDF, no DOM, no network.
//
// A drawing set is many pages of mixed roles. This walker takes per-page signals
// and produces one routing PLAN for the whole set: what each page is, how it
// will be read, and what the user should confirm. It does NOT do the reading —
// it decides the work, so the thumbnail-confirmation UI can show suggestions and
// the set runner can execute the confirmed plan.
//
// Per page it combines the two classifiers built in steps 1-2:
//   classifyPageRole   -> plan | schedule | legend | detail   (what the page IS)
//   classifySheet/route-> device_list | quantity_matrix | label_stamp (how to read its tables)
// into a single per-page decision with a `work` tag the runner dispatches on:
//   'count_labels'   plan sheet -> detect.js anchor/label counting (+ symbols later)
//   'read_schedule'  schedule sheet -> the routed archetype reader
//   'discover'       legend sheet -> discovery (type vocabulary)
//   'skip'           detail/elevation -> not counted
//   'confirm'        low-confidence -> user assigns before the set runs
//
// CROSS-SHEET IDENTITY (the new failure mode this step introduces): a device
// can be COUNTED on a plan and also LISTED on a schedule. Counting both double-
// counts; counting neither drops it. The plan decides, per type, which sheet is
// the count authority and which is corroboration — it never sums both blindly.

import { classifyPageRole } from './classify-page-role.js';
import { classifySheet } from './classify-archetype.js';

// Runner dispatch for a HUMAN-ASSIGNED page role — the authoritative path, no
// auto-classifier. An unassigned/unknown role returns 'needs_role' so the runner
// can BLOCK rather than count: nothing counts until a human has named the page.
//   plan     -> 'count'          (detect + symbol)
//   schedule -> 'read_schedule'  (schedule reader; symbol detection skipped)
//   legend|detail|skip -> 'skip' (not counted)
//   null / anything else -> 'needs_role' (BLOCK)
export function runnerWorkForRole(role) {
  switch (role) {
    case 'plan': return 'count';
    case 'schedule': return 'read_schedule';
    case 'legend':
    case 'detail':
    case 'skip': return 'skip';
    default: return 'needs_role';
  }
}

// Set-level gate: in a multi-page run NO page counts until EVERY selected page
// has a role. Returns the pages still missing a role; empty array => clear to run.
// `pages` is [{ pdf_page_number, page_role }]. Pure.
export function unassignedPages(pages = []) {
  return pages
    .filter((p) => runnerWorkForRole(p.page_role) === 'needs_role')
    .map((p) => p.pdf_page_number);
}

// Map (role, archetype) -> the work the runner performs on this page.
function workFor(role, archetype) {
  if (role === 'legend') return 'discover';
  if (role === 'detail') return 'skip';
  if (role === 'schedule') return 'read_schedule';
  if (role === 'plan') return 'count_labels';
  return 'confirm';
}

/**
 * Plan one page from its signals.
 * @param {Object} page
 *   { id, pdf_page_number, sheet_title,
 *     roleSignals,        // -> classifyPageRole (titlePhrases/lines + structure)
 *     sheetSignals }      // -> classifySheet (tables + anchorTokenCount)
 * @returns {Object} per-page plan entry
 */
export function planPage(page = {}) {
  const roleResult = classifyPageRole(page.roleSignals || {});
  // Only schedule/plan pages need an archetype; legend/detail don't read tables.
  let routeResult = null;
  if (roleResult.role === 'schedule' || roleResult.role === 'plan' || roleResult.needs_user) {
    routeResult = classifySheet(page.sheetSignals || {});
  }

  let work = workFor(roleResult.role, routeResult && routeResult.archetype);
  // Low-confidence role always goes to the user first, regardless of work.
  const needsConfirm = roleResult.needs_user || roleResult.confidence === 'low';
  if (needsConfirm) work = 'confirm';

  return {
    page_id: page.id ?? null,
    pdf_page_number: page.pdf_page_number ?? null,
    sheet_title: page.sheet_title ?? null,
    role: roleResult.role,
    role_confidence: roleResult.confidence,
    role_alternates: roleResult.alternates || [],
    archetype: routeResult ? routeResult.archetype : null,
    archetype_route: routeResult ? (routeResult.route || null) : null,
    work,
    needs_confirm: needsConfirm,
  };
}

/**
 * Plan a whole set.
 * @param {Array} pages  per-page signal objects (see planPage)
 * @returns {{ pages, count_sources, cross_sheet, summary }}
 */
export function planSet(pages = []) {
  const planned = pages.map(planPage);

  // Cross-sheet identity: for each device type, which pages would COUNT it
  // (plan label-count) and which would LIST it (schedule). When a type appears
  // in both, the schedule is the count authority (it's the engineer's tally);
  // the plan becomes location/corroboration. We surface these so the runner —
  // and the user — see where a double-count risk lives, instead of silently
  // summing. (Type-level resolution happens at reconcile; here we only FLAG.)
  const countPages = planned.filter((p) => p.work === 'count_labels').map((p) => p.pdf_page_number);
  const schedulePages = planned.filter((p) => p.work === 'read_schedule').map((p) => p.pdf_page_number);
  const cross_sheet = {
    has_plans: countPages.length > 0,
    has_schedules: schedulePages.length > 0,
    // When a set has BOTH, counts must be reconciled across sheets, not summed.
    needs_cross_sheet_reconcile: countPages.length > 0 && schedulePages.length > 0,
    count_pages: countPages,
    schedule_pages: schedulePages,
    note: countPages.length > 0 && schedulePages.length > 0
      ? 'Set has both plan and schedule sheets: schedule is count authority per type; plans provide location. Do not sum both.'
      : null,
  };

  const by = (w) => planned.filter((p) => p.work === w).length;
  const summary = {
    total: planned.length,
    count_labels: by('count_labels'),
    read_schedule: by('read_schedule'),
    discover: by('discover'),
    skip: by('skip'),
    confirm: by('confirm'),
  };

  return { pages: planned, count_sources: { countPages, schedulePages }, cross_sheet, summary };
}

export default planSet;
