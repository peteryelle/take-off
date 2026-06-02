-- backfill-qts-camera-template.sql  (project 5 "QTS - 4page")
-- Substep 6 backfill, generated against the REAL rows (verified via Supabase read):
--   64 "1 Lens Camera"  -> cam_1lens   (cfg was NULL: full v2 config written)
--   65 "3 lens camera"  -> cam_3lens   (cfg was NULL: full v2 config written)
--   62 "4 lens camera"  -> cam_4lens   (cfg existed: full v2 config re-written, type+template set)
-- reconcile joins symbols by detection_config.type (|| name). We set cfg.type to the
-- stable cam_* token that blobsToInstances stamps on each instance, so the join is
-- name-independent. All three share ONE symbol_template (one red fill, 3 prototypes);
-- the locator dedups them into a single vector pass and splits by prototype.
-- Idempotent: re-running overwrites detection_config with the same value.

-- 1 Lens Camera (id 64) -> cam_1lens
update device_types set detection_config = '{"source":"backfill","sources":["symbol"],"version":2,"families":[],"cluster_pt":25,"anchor_mode":"exact","name_source":"legend_match","uin_pattern":null,"match_tolerance":0.05,"type":"cam_1lens","symbol_template":{"fill_rgb":[255,87,87],"fill_tol":48,"body_area":0.00002,"prototypes":[{"type":"cam_1lens","n":11,"sig":{"lobe_count":2,"arms":2,"n_subpaths":8,"aspect":3.3082742735512625,"area_ratio":0.42191353161446377,"fill_ratio":1,"spikiness":2.0699480255380625,"envelope":[]},"lens_class":"1-lens"},{"type":"cam_3lens","n":2,"sig":{"lobe_count":2,"arms":4,"n_subpaths":14,"aspect":2.0232921161065973,"area_ratio":0.4961187214612742,"fill_ratio":1,"spikiness":2.0161907113920132,"envelope":[]},"lens_class":"3-lens"},{"type":"cam_4lens","n":4,"sig":{"lobe_count":0,"arms":4,"n_subpaths":9,"aspect":1.3469447200400464,"area_ratio":0.4797418715445108,"fill_ratio":1,"spikiness":1.5115067662761885,"envelope":[]},"lens_class":"4-lens"}]},"anchor_confidence":"high","leader_from_anchor":false}'::jsonb
 where id = 64 and project_id = 5;

-- 3 lens camera (id 65) -> cam_3lens
update device_types set detection_config = '{"source":"backfill","sources":["symbol"],"version":2,"families":[],"cluster_pt":25,"anchor_mode":"exact","name_source":"legend_match","uin_pattern":null,"match_tolerance":0.05,"type":"cam_3lens","symbol_template":{"fill_rgb":[255,87,87],"fill_tol":48,"body_area":0.00002,"prototypes":[{"type":"cam_1lens","n":11,"sig":{"lobe_count":2,"arms":2,"n_subpaths":8,"aspect":3.3082742735512625,"area_ratio":0.42191353161446377,"fill_ratio":1,"spikiness":2.0699480255380625,"envelope":[]},"lens_class":"1-lens"},{"type":"cam_3lens","n":2,"sig":{"lobe_count":2,"arms":4,"n_subpaths":14,"aspect":2.0232921161065973,"area_ratio":0.4961187214612742,"fill_ratio":1,"spikiness":2.0161907113920132,"envelope":[]},"lens_class":"3-lens"},{"type":"cam_4lens","n":4,"sig":{"lobe_count":0,"arms":4,"n_subpaths":9,"aspect":1.3469447200400464,"area_ratio":0.4797418715445108,"fill_ratio":1,"spikiness":1.5115067662761885,"envelope":[]},"lens_class":"4-lens"}]},"anchor_confidence":"high","leader_from_anchor":false}'::jsonb
 where id = 65 and project_id = 5;

-- 4 lens camera (id 62) -> cam_4lens
update device_types set detection_config = '{"source":"backfill","sources":["symbol"],"version":2,"families":[],"cluster_pt":25,"anchor_mode":"exact","name_source":"legend_match","uin_pattern":null,"match_tolerance":0.05,"type":"cam_4lens","symbol_template":{"fill_rgb":[255,87,87],"fill_tol":48,"body_area":0.00002,"prototypes":[{"type":"cam_1lens","n":11,"sig":{"lobe_count":2,"arms":2,"n_subpaths":8,"aspect":3.3082742735512625,"area_ratio":0.42191353161446377,"fill_ratio":1,"spikiness":2.0699480255380625,"envelope":[]},"lens_class":"1-lens"},{"type":"cam_3lens","n":2,"sig":{"lobe_count":2,"arms":4,"n_subpaths":14,"aspect":2.0232921161065973,"area_ratio":0.4961187214612742,"fill_ratio":1,"spikiness":2.0161907113920132,"envelope":[]},"lens_class":"3-lens"},{"type":"cam_4lens","n":4,"sig":{"lobe_count":0,"arms":4,"n_subpaths":9,"aspect":1.3469447200400464,"area_ratio":0.4797418715445108,"fill_ratio":1,"spikiness":1.5115067662761885,"envelope":[]},"lens_class":"4-lens"}]},"anchor_confidence":"high","leader_from_anchor":false}'::jsonb
 where id = 62 and project_id = 5;

-- verify after running:
-- select id, name, detection_config->>'type' as cfg_type,
--        detection_config->'sources' as sources,
--        jsonb_array_length(detection_config->'symbol_template'->'prototypes') as n_proto
-- from device_types where id in (62,64,65) order by id;
