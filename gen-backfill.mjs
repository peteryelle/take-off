import { readFileSync, writeFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync('fixtures/qts-camera-prototypes.json'));
const tmpl = { fill_rgb: fx.fill_rgb, fill_tol: fx.fill_tol, body_area: fx.body_area, prototypes: fx.prototypes };

// v2 config skeleton modeled on the discovered row 62, one per lens token.
const base = (type) => ({
  source: 'backfill', sources: ['symbol'], version: 2, families: [], cluster_pt: 25,
  anchor_mode: 'exact', name_source: 'legend_match', uin_pattern: null, match_tolerance: 0.05,
  type, symbol_template: tmpl, anchor_confidence: 'high', leader_from_anchor: false,
});

const rows = [
  { id: 64, name: '1 Lens Camera', token: 'cam_1lens' },
  { id: 65, name: '3 lens camera', token: 'cam_3lens' },
  { id: 62, name: '4 lens camera', token: 'cam_4lens' },
];

let sql = `-- backfill-qts-camera-template.sql  (project 5 "QTS - 4page")
-- Substep 6 backfill, generated against the REAL rows (verified via Supabase read):
--   64 "1 Lens Camera"  -> cam_1lens   (cfg was NULL: full v2 config written)
--   65 "3 lens camera"  -> cam_3lens   (cfg was NULL: full v2 config written)
--   62 "4 lens camera"  -> cam_4lens   (cfg existed: full v2 config re-written, type+template set)
-- reconcile joins symbols by detection_config.type (|| name). We set cfg.type to the
-- stable cam_* token that blobsToInstances stamps on each instance, so the join is
-- name-independent. All three share ONE symbol_template (one red fill, 3 prototypes);
-- the locator dedups them into a single vector pass and splits by prototype.
-- Idempotent: re-running overwrites detection_config with the same value.

`;
for (const r of rows) {
  const cfg = JSON.stringify(base(r.token)).replace(/'/g, "''");
  sql += `-- ${r.name} (id ${r.id}) -> ${r.token}\n`;
  sql += `update device_types set detection_config = '${cfg}'::jsonb\n where id = ${r.id} and project_id = 5;\n\n`;
}
sql += `-- verify after running:
-- select id, name, detection_config->>'type' as cfg_type,
--        detection_config->'sources' as sources,
--        jsonb_array_length(detection_config->'symbol_template'->'prototypes') as n_proto
-- from device_types where id in (62,64,65) order by id;
`;
writeFileSync('backfill-qts-camera-template.sql', sql);
console.log('wrote per-row backfill; template json bytes:', JSON.stringify(tmpl).length);
console.log('tokens:', rows.map((r) => `${r.id}->${r.token}`).join(', '));
