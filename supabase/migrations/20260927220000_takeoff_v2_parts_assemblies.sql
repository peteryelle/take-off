-- WF8 pass 2: parts catalog keyed by part number, assemblies per BOM item, pricing settings.
-- A BOM item (a quantity WF8 carries, e.g. "wf6:CN1" or "wf4:count:2D") can have an assembly:
-- the parts it takes per unit of the item, times a waste factor. Parts and prices live in the
-- org's parts catalog (reusable across projects); margin and labor rate are per project.

-- parts: identity is the part number (a catalog can hold parts no BOM item uses yet)
ALTER TABLE takeoff.parts ALTER COLUMN bom_item DROP NOT NULL;
ALTER TABLE takeoff.parts DROP CONSTRAINT IF EXISTS parts_catalog_id_bom_item_key;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'takeoff.parts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%unit%'
  LOOP EXECUTE format('ALTER TABLE takeoff.parts DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE takeoff.parts ADD CONSTRAINT parts_catalog_part_number UNIQUE (catalog_id, part_number);
ALTER TABLE takeoff.parts
  ADD COLUMN category   text,
  ADD COLUMN notes      text,
  ADD COLUMN updated_by uuid REFERENCES auth.users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- assemblies: per project, per BOM item
CREATE TABLE takeoff.assemblies (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES public.organizations(id),
  project_id   bigint NOT NULL REFERENCES takeoff.projects(id) ON DELETE CASCADE,
  item_key     text   NOT NULL,             -- WF8 item key
  item_label   text,                        -- the item as shown when the line was entered
  part_number  text   NOT NULL,             -- matched to takeoff.parts in the project's catalog
  qty          numeric NOT NULL CHECK (qty >= 0),   -- per unit of the item (per ft when the item is in ft)
  waste        numeric NOT NULL DEFAULT 1 CHECK (waste >= 1),
  note         text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','imported')),
  entered_by   uuid REFERENCES auth.users(id),
  entered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, item_key, part_number)
);
CREATE INDEX idx_to_assemblies_project ON takeoff.assemblies(project_id);
ALTER TABLE takeoff.assemblies ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON takeoff.assemblies FOR ALL TO authenticated
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

-- pricing settings per project
ALTER TABLE takeoff.projects
  ADD COLUMN material_margin numeric CHECK (material_margin >= 0 AND material_margin < 1),
  ADD COLUMN labor_rate      numeric CHECK (labor_rate >= 0);

NOTIFY pgrst, 'reload schema';
