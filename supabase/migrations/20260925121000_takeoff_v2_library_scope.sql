-- Take-Off v2 — Migration 3b: device libraries scoped by customer + AE, optionally one drawing set
ALTER TABLE takeoff.device_libraries RENAME COLUMN designer TO ae_firm;
ALTER TABLE takeoff.device_libraries ADD COLUMN client text;
ALTER TABLE takeoff.device_libraries ADD COLUMN project_id bigint REFERENCES takeoff.projects(id) ON DELETE CASCADE;
ALTER TABLE takeoff.device_libraries ADD COLUMN based_on_library_id bigint REFERENCES takeoff.device_libraries(id) ON DELETE SET NULL;
CREATE INDEX idx_to_device_libraries_scope ON takeoff.device_libraries(org_id, client, ae_firm);
CREATE INDEX idx_to_device_libraries_project ON takeoff.device_libraries(project_id);

-- confirm
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='takeoff' AND table_name='device_libraries' ORDER BY ordinal_position;
