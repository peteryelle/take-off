-- Task B: re-add 'schedule' to FP and ALM detection sources.
--
-- These were stripped to ['label'] this session to kill phantom no_uin symbol
-- detections (faceplate/text-anchored types are label-only — see the FP/ALM symbol
-- fix). But 'schedule' in `sources` is a SEPARATE axis from 'symbol': it gates
-- reconcile's scheduleActive() so plan labels reconcile against the persisted
-- schedule_rows, and a scheduled-type plan label with no matching schedule UIN is
-- flagged not_in_schedule (e.g. ALM-1100B on the plan but absent from the page-8
-- schedule). pass-batch.js seeds reconcile from schedule_rows for exactly the types
-- carrying 'schedule' here, so this flip is what activates that path.
--
-- Idempotent: only appends 'schedule' when not already present.
update device_types dt
set detection_config = jsonb_set(
      dt.detection_config,
      '{sources}',
      (select jsonb_agg(distinct e)
         from jsonb_array_elements_text(
                coalesce(dt.detection_config->'sources', '[]'::jsonb) || '["schedule"]'::jsonb) e)
    )
where dt.project_id = 5
  and dt.detection_config->>'anchor' in ('FP', 'ALM')
  and not (dt.detection_config->'sources' ? 'schedule');
