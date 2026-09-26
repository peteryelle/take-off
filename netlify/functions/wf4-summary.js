// netlify/functions/wf4-summary.js
// WF4 copy of takeoff-summary.js — everything the WF4 screens need to restore
// a project, plus the Review roll-up (public/lib/wf4-rollup.js). Free — no
// metered calls.
//
// GET /api/wf/wf4/summary?project_id=1
//
// Kept from the old endpoint: device types, pages, TR pins (as `demarcs`),
// page regions, device instances (old field names total_ft / demarc_id kept
// alongside the v2 ones). Dropped: parts catalog, labor tasks, library badge,
// project lock and the dead rollup views — those belong to WF8 (BOM) in v2.
// Added: routing settings, waypoints, wall calibration, and `rollup`.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from './utils/clients.js';
import { requireOrg } from './utils/auth.js';
import { td, assertWfProjectInOrg } from './utils/takeoff-db.js';
import { pinToDemarc, regionToLegacy } from './utils/wf4-map.js';
import { rollup } from '../../public/lib/wf4-rollup.js';

const PAGE_COLS = 'id, document_id, page_number, title_text, sheet_id, role, role_source, building, level, zone, phase, is_duplicate, ' +
  'content_hash, run_status, run_status_msg, scale_label, scale_paper_in, scale_real_ft, scale_pts_per_ft, ' +
  'drawing_x0, drawing_y0, drawing_x1, drawing_y1, content_xmin_frac, content_ymin_frac, content_w_frac, content_h_frac, ' +
  'sheet_class, leader_overrides, route_mode, route_multiplier';

const TYPE_COLS = 'id, name, legend_id, legend_suggestion, human_description, llm_description, text_anchors, ' +
  'detection_config, example_image_base64, tia_limit_ft, verified, detect_mode, crop_path';

const DEVICE_COLS = 'id, page_id, device_type_id, source, override_basis, detection_method, x_norm, y_norm, x_ft, y_ft, ' +
  'raw_labels, data_ports, voice_ports, node_labels, port_count_data, port_count_voice, ' +
  'tr_pin_id, tr_name, tr_id, level, zone, route_method, route_ft_raw, route_multiplier, route_ft, ' +
  'route_geometry, routed_via_tier3, tia_flag, tia_reason, confidence, xy_source, symbol_via, ' +
  'flags, cull_category, cull_reason, excluded, uin';

// PostgREST caps an unpaginated request at 1000 rows; a real drawing set can
// exceed that, and a silent truncation would under-count. Page through by id.
async function fetchAll(query, pageSize = 1000) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await query().order('id').range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) return all;
    from += pageSize;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
  if (req.method !== 'GET') return err('GET required', 405);

  const projectId = new URL(req.url).searchParams.get('project_id');
  if (!projectId) return err('project_id required');

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;
  const db = td(supabase);
  if (!(await assertWfProjectInOrg(supabase, projectId, orgId))) return err('Project not found', 404);

  try {
    const { data: project, error: pErr } = await db.from('projects')
      .select('id, name, number, device_library_id, route_mode, straight_multiplier, right_angle_multiplier, routed_multiplier')
      .eq('id', projectId).single();
    if (pErr) throw new Error(pErr.message);

    const [types, pages, pins, regions, devices, waypoints, calib] = await Promise.all([
      project.device_library_id
        ? fetchAll(() => db.from('device_types').select(TYPE_COLS).eq('library_id', project.device_library_id))
        : Promise.resolve([]),
      fetchAll(() => db.from('pages').select(PAGE_COLS).eq('project_id', projectId)),
      fetchAll(() => db.from('tr_pins').select('*').eq('project_id', projectId)),
      fetchAll(() => db.from('page_regions').select('id, page_id, label, kind, tr_pin_id, polygon, x0, y0, x1, y1').eq('project_id', projectId)),
      fetchAll(() => db.from('device_instances').select(DEVICE_COLS).eq('project_id', projectId)),
      fetchAll(() => db.from('waypoints').select('id, page_id, x_norm, y_norm, label').eq('project_id', projectId)),
      db.from('wall_calibrations').select('*').eq('project_id', projectId).maybeSingle().then((r) => r.data ?? null),
    ]);

    const typeById = new Map(types.map((t) => [String(t.id), t]));
    const deviceRows = devices.map((d) => ({
      ...d,
      legend_id: typeById.get(String(d.device_type_id))?.legend_id ?? null,
      name: typeById.get(String(d.device_type_id))?.name ?? null,
      total_ft: d.route_ft,        // old field name
      demarc_id: d.tr_pin_id,      // old field name
    }));

    const sortedPages = pages.slice().sort((a, b) => (a.document_id - b.document_id) || (a.page_number - b.page_number));

    return ok({
      project_id: Number(projectId),
      project: { name: project.name, number: project.number, device_library_id: project.device_library_id },
      routing: {
        mode: project.route_mode,
        multipliers: {
          straight: Number(project.straight_multiplier),
          right_angle: Number(project.right_angle_multiplier),
          routed: Number(project.routed_multiplier),
        },
      },
      device_types: types,
      pages: sortedPages,
      demarcs: pins.map(pinToDemarc),
      page_regions: regions.map(regionToLegacy),
      device_instances: deviceRows,
      waypoints,
      wall_calibration: calib,
      rollup: rollup(deviceRows, sortedPages, types),
    });
  } catch (e) {
    return err(e.message, 500);
  }
}

export const config = { path: '/api/wf/wf4/summary' };
