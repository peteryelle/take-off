// rack-orchestration.js — joins tr_schedule_rows (T-500 totals), a TR room's
// confirmed device list (tr_room_devices), and the project's fiber plant
// type into one sized-rack result per TR. Pure functions only — no PDF, no
// DOM, no network, no Supabase. Callers (the netlify function) do the reads
// and writes; this module only computes.
//
// Why "confirmed" gates everything: a room that hasn't been reviewed and one
// that has can otherwise look the same. tr-room-review.html's own "Save
// rack_count to TR Schedule" button is already the confirmation act — it
// writes tr_schedule_rows.rack_count directly once a human has reviewed the
// confidence map. So confirmation state is NOT a separate flag this module
// tracks: scheduleRow.rack_count == null means unconfirmed, a number means
// confirmed (even 0, e.g. DB97-1 — existing racks only, genuinely sized as
// zero). No parallel confirmation table; this reads the one place the app
// already writes that fact.
//
// rack_count itself is already NEW-racks-only by construction: tr-room-
// review.html's saveRollupToSchedule() filters devices to category ===
// 'rack_new' before writing (categorize-coded-note.js's distinction between
// a NEW rack, T-401 note 2, and an EXISTING one being retained, notes
// 9/11/12). This module trusts that filtering already happened and never
// re-derives the count from raw device rows itself.
//
// Why fiber is a project-level input, not per-TR: confirmed (Peter, chat)
// the plant type is the same across every TR on a job. A TR can be sized
// with fiber_pending:true before that project-level parse exists; the
// result is never blocked on it, just flagged.

import { distributePatchPanels, sidecarCount, totalCassetteCount } from './rack-assembly-rules.js';

/**
 * Size one TR's rack components from its schedule row and the project's
 * fiber plant type.
 *
 * @param {{tr_number: string, min_patch_panels: number, rack_count: number|null}} scheduleRow
 *   one row from tr_schedule_rows. rack_count is null until a human confirms
 *   the room's scan via tr-room-review.html's Save button — that column IS
 *   the confirmation signal, so there's no separate status input here.
 *   min_patch_panels is T-500's "Minimum Number of Patch Panels" column, the
 *   only other schedule figure this needs (total_terminations isn't a sizing
 *   input, it's a separate capacity check).
 * @param {'ISP'|'OSP'|null} plantType  from project_fiber_config; null means
 *   the fiber-feed pass hasn't run yet for this project
 * @returns {{
 *   tr_number: string, sized: boolean, reason?: string,
 *   rack_count?: number, patch_panel_distribution?: number[],
 *   sidecar_count?: number, fiber_cassette_count?: number|null,
 *   fiber_pending?: boolean
 * }}
 */
export function sizeTrRacks(scheduleRow, plantType = null) {
  const tr_number = scheduleRow?.tr_number;

  if (scheduleRow?.rack_count == null) {
    return { tr_number, sized: false, reason: 'room not confirmed — save rack_count from the confidence map first' };
  }

  const rackCount = scheduleRow.rack_count;
  if (!(rackCount > 0)) {
    // A confirmed room can genuinely have zero NEW racks (e.g. DB97-1 in
    // this project's own fixture set — existing racks only, no new scope).
    // That's a real, sized answer, not a missing one.
    return {
      tr_number, sized: true, rack_count: 0,
      patch_panel_distribution: [], sidecar_count: 0,
      fiber_cassette_count: null, fiber_pending: plantType == null,
    };
  }

  const patch_panel_distribution = distributePatchPanels(scheduleRow.min_patch_panels, rackCount);
  const fiber_cassette_count = plantType ? totalCassetteCount(plantType) : null;

  return {
    tr_number,
    sized: true,
    rack_count: rackCount,
    patch_panel_distribution,
    sidecar_count: sidecarCount(rackCount),
    fiber_cassette_count,
    fiber_pending: plantType == null,
  };
}

export default { sizeTrRacks };
