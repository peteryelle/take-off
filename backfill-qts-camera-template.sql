-- backfill-qts-camera-template.sql
-- Substep 6 backfill: write the hand-seeded vector symbol_template onto the QTS camera
-- device types so the locator routes them VECTOR (substep 7 box-select replaces this).
--
-- COUPLING TO VERIFY BEFORE RUNNING:
--   reconcile joins symbol instances to devices by TYPE. blobsToInstances stamps each
--   instance with the matched prototype.type below (currently '1-lens'/'3-lens'/'4-lens').
--   Those strings MUST equal the detection_config.type of the camera rows you target, or
--   the glyphs will not fold and will surface as no_uin. If your QTS camera types use
--   different names, edit the "type" values inside the JSON below to match them.
--
--   Set <PROJECT_ID> and confirm the WHERE clause selects exactly your camera type rows.
--   All matched rows get the SAME template (one red fill, 3 lens-class prototypes); the
--   locator dedups them into one vector locate pass.

update device_types
set detection_config = jsonb_set(
      jsonb_set(coalesce(detection_config, '{}'::jsonb),
                '{symbol_template}', '{"fill_rgb":[255,87,87],"fill_tol":48,"body_area":0.00002,"prototypes":[{"type":"1-lens","n":11,"sig":{"lobe_count":2,"arms":2,"n_subpaths":8,"aspect":3.3082742735512625,"area_ratio":0.42191353161446377,"fill_ratio":1,"spikiness":2.0699480255380625,"envelope":[]}},{"type":"3-lens","n":2,"sig":{"lobe_count":2,"arms":4,"n_subpaths":14,"aspect":2.0232921161065973,"area_ratio":0.4961187214612742,"fill_ratio":1,"spikiness":2.0161907113920132,"envelope":[]}},{"type":"4-lens","n":4,"sig":{"lobe_count":0,"arms":4,"n_subpaths":9,"aspect":1.3469447200400464,"area_ratio":0.4797418715445108,"fill_ratio":1,"spikiness":1.5115067662761885,"envelope":[]}}]}'::jsonb, true),
      '{sources}',
      coalesce(detection_config->'sources','[]'::jsonb)
        || case when coalesce(detection_config->'sources','[]'::jsonb) @> '["symbol"]'::jsonb
                then '[]'::jsonb else '["symbol"]'::jsonb end, true)
where project_id = '<PROJECT_ID>'
  and name ilike '%camera%';   -- VERIFY: selects exactly your 1/3/4-lens camera rows

-- sanity check after running:
-- select id, name, detection_config->'symbol_template'->'fill_rgb' as fill,
--        jsonb_array_length(detection_config->'symbol_template'->'prototypes') as n_proto,
--        detection_config->'sources' as sources
-- from device_types where project_id='<PROJECT_ID>' and name ilike '%camera%';
