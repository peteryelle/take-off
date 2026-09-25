-- Take-Off v2 — Migration 3: device libraries and parts catalogs (org-level, shared across projects)

CREATE TABLE takeoff.device_libraries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES public.organizations(id),
  name         text   NOT NULL,
  designer     text,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE takeoff.parts_catalogs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES public.organizations(id),
  name         text   NOT NULL,
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE takeoff.parts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES public.organizations(id),
  catalog_id    bigint NOT NULL REFERENCES takeoff.parts_catalogs(id) ON DELETE CASCADE,
  bom_item      text   NOT NULL,
  mfr           text,
  part_number   text,
  description   text,
  unit          text   NOT NULL DEFAULT 'ea' CHECK (unit IN ('ea','ft','lot')),
  unit_cost     numeric(12,2),
  labor_min     numeric(8,2),
  source_url    text,
  retrieved_at  timestamptz,
  UNIQUE (catalog_id, bom_item)
);

CREATE TABLE takeoff.device_types (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            bigint NOT NULL REFERENCES public.organizations(id),
  library_id        bigint NOT NULL REFERENCES takeoff.device_libraries(id) ON DELETE CASCADE,
  name              text   NOT NULL,
  ports             integer,
  detect_mode       text   NOT NULL DEFAULT 'label' CHECK (detect_mode IN ('label','shape')),
  label_text        text,
  crop_path         text,
  detection_config  jsonb,
  legend_suggestion text,
  bom_item          text,
  created_by        uuid REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (library_id, name)
);

ALTER TABLE takeoff.projects
  ADD CONSTRAINT projects_device_library_fk FOREIGN KEY (device_library_id)
  REFERENCES takeoff.device_libraries(id) ON DELETE SET NULL;
ALTER TABLE takeoff.projects
  ADD CONSTRAINT projects_parts_catalog_fk FOREIGN KEY (parts_catalog_id)
  REFERENCES takeoff.parts_catalogs(id) ON DELETE SET NULL;
ALTER TABLE takeoff.role_rules
  ADD CONSTRAINT role_rules_device_library_fk FOREIGN KEY (device_library_id)
  REFERENCES takeoff.device_libraries(id) ON DELETE CASCADE;
ALTER TABLE takeoff.device_instances
  ADD CONSTRAINT device_instances_device_type_fk FOREIGN KEY (device_type_id)
  REFERENCES takeoff.device_types(id) ON DELETE SET NULL;

CREATE INDEX idx_to_parts_catalog ON takeoff.parts(catalog_id);
CREATE INDEX idx_to_device_types_library ON takeoff.device_types(library_id);
CREATE INDEX idx_to_device_instances_type ON takeoff.device_instances(device_type_id);

ALTER TABLE takeoff.device_libraries ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.device_libraries FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.parts_catalogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.parts_catalogs FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.parts FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());
ALTER TABLE takeoff.device_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.device_types FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA takeoff TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA takeoff TO authenticated, service_role;

-- confirm: 26 tables, all rls_on; 4 new FKs present
SELECT conname FROM pg_constraint
WHERE conname IN ('projects_device_library_fk','projects_parts_catalog_fk','role_rules_device_library_fk','device_instances_device_type_fk');
