// rack-orchestration.js — joins tr_schedule_rows (T-500 totals), a TR room's
// confirmed device list (tr_room_devices), and the project's fiber plant
// type into one sized-rack result per TR. Pure functions only — no PDF, no
// DOM, no network, no Supabase. Callers (the netlify function) do the reads
// and writes; this module only computes.
//
// Why "confirmed" gates everything: a scan that ran but hasn't been reviewed
// through the tr-room-review.html confidence map and an unscanned room can
// produce the exact same numeric signature (zero or a partial rack count).
// Sizing an unconfirmed count would silently treat "not done yet" the same
// as "verified true" — this module refuses to compute past that point and
// says why, rather than guessing which case it's looking at.
//
// Why rack_new only, never rack_existing: categorize-coded-note.js already
// separates a NEW rack (T-401 note 2: "PROVIDE 24" X 30" 45RU 4-POST
// EQUIPMENT RACK") from an EXISTING one being retained (notes 9/11/12:
// "EXISTING NETWORK RACK... TO REMAIN"). Only new racks need new patch
// panels, sidecars, and cassettes sized against them — counting an existing
// rack here would inflate every retrofit TR's component counts for
// hardware that isn't part of this scope of work.
//
// Why fiber is a project-level input, not per-TR: confirmed (Peter, chat)
// the plant type is the same across every TR on a job. A TR can be sized
// with fiber_pending:true before that project-level parse exists; the
// result is never blocked on it, just flagged.

import { distributePatchPanels, sidecarCount, totalCassetteCount } from './rack-assembly-rules.js';

/**
 * Count NEW racks from a TR room's confirmed device list.
 * @param {Array<{category: string|null}>} trRoomDevices  all tr_room_devices
 *   rows for one tr_number (any source: leader_fan or manual)
 * @returns {number}
 */
export function deriveRackCount(trRoomDevices = []) {
  return trRoomDevices.filter((d) => d && d.category === 'rack_new').length;
}

/**
 * Size one TR's rack components from its schedule row, room-scan status, and
 * the project's fiber plant type.
 *
 * @param {{tr_number: string, min_patch_panels: number}} scheduleRow
 *   one row from tr_schedule_rows (min_patch_panels is T-500's "Minimum
 *   Number of Patch Panels" column, the only schedule figure this needs —
 *   total_terminations isn't a sizing input, it's a separate capacity check)
 * @param {{status: 'pending'|'scanned'|'confirmed', rack_count?: number}} roomStatus
 *   rack_count only matters (and is only read) when status is 'confirmed'
 * @param {'ISP'|'OSP'|null} plantType  from project_fiber_config; null means
 *   the fiber-feed pass hasn't run yet for this project
 * @returns {{
 *   tr_number: string, sized: boolean, reason?: string,
 *   rack_count?: number, patch_panel_distribution?: number[],
 *   sidecar_count?: number, fiber_cassette_count?: number|null,
 *   fiber_pending?: boolean
 * }}
 */
export function sizeTrRacks(scheduleRow, roomStatus, plantType = null) {
  const tr_number = scheduleRow?.tr_number;

  if (!roomStatus || roomStatus.status !== 'confirmed') {
    return {
      tr_number,
      sized: false,
      reason: !roomStatus || roomStatus.status === 'pending'
        ? 'room not scanned'
        : 'scan not yet confirmed — review the confidence map',
    };
  }

  const rackCount = roomStatus.rack_count ?? 0;
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

export default { deriveRackCount, sizeTrRacks };
