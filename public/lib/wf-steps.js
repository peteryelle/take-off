// public/lib/wf-steps.js
// Workflow step definitions and status logic for the v2 take-off flow.
// Pure (no DOM, no network) so it runs in the browser and in node tests.
//
// Dependencies are a RECOMMENDED ORDER, never a lock: any step can be opened
// on its own. When an upstream step isn't confirmed, the step still works and
// we tell the user what is degraded (e.g. "TR names are typed, not picked").
// ─────────────────────────────────────────────────────────────────────────────

export const STEPS = [
  { code: 'WF1', name: 'Legend & notes', roles: ['legend', 'notes'], page: 'wf1.html' },
  { code: 'WF2', name: 'Schedule', roles: ['schedule'], page: 'wf2.html' },
  { code: 'WF3', name: 'OSP site fiber', roles: ['osp_route', 'osp_overview'], page: 'wf3.html' },
  { code: 'WF4', name: 'Floor plans', roles: ['plan', 'key_plan'], page: 'wf4.html' },
  { code: 'WF5', name: 'TR rooms', roles: ['tr_room'], page: 'wf-soon.html' },
  { code: 'WF6', name: 'Rack & details', roles: ['rack', 'detail'], page: 'wf-soon.html' },
  { code: 'WF7', name: 'Riser', roles: ['riser'], page: 'wf-soon.html' },
  { code: 'WF8', name: 'BOM', roles: [], page: 'wf-soon.html' },
];

export const STEP_CODES = STEPS.map((s) => s.code);

// What a step loses while each upstream step is unconfirmed.
export const RECOMMENDED = {
  WF1: [],
  WF2: [],
  WF3: [{ needs: 'WF1', without: 'default line types (red new, blue existing, black dotted tunnel)' },
        { needs: 'WF2', without: 'building entries are not matched to TRs' }],
  WF4: [{ needs: 'WF1', without: 'no name suggestions for cropped symbols' },
        { needs: 'WF2', without: 'TR names are typed at each pin, not picked; ports-vs-terminations check waits' }],
  WF5: [{ needs: 'WF2', without: 'TR names are typed; rack cross-check against the schedule waits' }],
  WF6: [{ needs: 'WF2', without: 'racks per TR cannot be built until the schedule counts exist' }],
  WF7: [{ needs: 'WF2', without: 'riser TRs are not checked against the schedule' },
        { needs: 'WF3', without: 'ISP/OSP is set by hand instead of matched to routes' }],
  WF8: [],
};

export const STATUS_LABEL = {
  open: 'open',
  extracted: 'extracted',
  in_review: 'in review',
  confirmed: 'confirmed',
  stale: 'changed',
  not_applicable: 'N/A',
};

export function stepDef(code) {
  return STEPS.find((s) => s.code === code) || null;
}

// Rows for a new project. Steps the user unchecked at setup start N/A.
// WF8 is always in scope — it's the output.
export function initialStepRows(inScope) {
  const scope = new Set(inScope && inScope.length ? inScope : STEP_CODES);
  scope.add('WF8');
  return STEP_CODES.map((code) => ({
    step_code: code,
    status: scope.has(code) ? 'open' : 'not_applicable',
  }));
}

// For one step: the upstream steps that are in scope but not confirmed, with
// what that means. N/A upstream steps are ignored (nothing will ever arrive).
export function missingUpstream(code, rows) {
  const byCode = Object.fromEntries((rows || []).map((r) => [r.step_code, r]));
  return (RECOMMENDED[code] || []).filter(({ needs }) => {
    const up = byCode[needs];
    return up && up.status !== 'confirmed' && up.status !== 'not_applicable';
  });
}

// WF8 is ready to generate only when every in-scope step WF1–WF7 is confirmed.
export function bomReady(rows) {
  const work = (rows || []).filter((r) => r.step_code !== 'WF8' && r.status !== 'not_applicable');
  return work.length > 0 && work.every((r) => r.status === 'confirmed');
}

// The single most useful next action for the overview banner.
// Priority: a stale step (drawings changed) > the first in-scope step in
// recommended order that isn't confirmed > BOM.
export function nextUp(rows) {
  const byCode = Object.fromEntries((rows || []).map((r) => [r.step_code, r]));
  const inScope = STEP_CODES.filter((c) => byCode[c] && byCode[c].status !== 'not_applicable');

  const stale = inScope.find((c) => byCode[c].status === 'stale');
  if (stale) {
    const reason = byCode[stale].stale_reason;
    return { code: stale, kind: 'stale', text: `${stepDef(stale).name} needs review${reason ? ' — ' + reason : ''}.` };
  }
  const todo = inScope.find((c) => c !== 'WF8' && byCode[c].status !== 'confirmed');
  if (todo) {
    const verb = byCode[todo].status === 'open' ? 'Start' : 'Finish';
    return { code: todo, kind: 'todo', text: `${verb} ${todo} · ${stepDef(todo).name}.` };
  }
  return { code: 'WF8', kind: 'bom', text: 'All steps confirmed. Generate the BOM.' };
}

// One line per step for the overview list.
export function stepSummary(code, rows) {
  const row = (rows || []).find((r) => r.step_code === code);
  if (!row) return { code, status: 'open', label: 'open', note: '' };
  if (row.status === 'not_applicable') return { code, status: row.status, label: 'N/A', note: 'not in this bid' };
  const missing = missingUpstream(code, rows);
  let note = '';
  if (row.status === 'stale' && row.stale_reason) note = row.stale_reason;
  else if (code === 'WF8') note = bomReady(rows) ? 'ready to generate' : 'waiting on confirmed steps';
  else if (missing.length) note = `works now; ${missing[0].without}`;
  return { code, status: row.status, label: STATUS_LABEL[row.status] || row.status, note };
}
