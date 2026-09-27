-- WF6 rack rules: data-driven. Every rule row comes from a coded or drawing note
-- on the rack elevation sheet (or is added by the user). Numbers a counting
-- method needs live in params, each tagged with where it came from:
--   params = { "<name>": { "v": <value>, "source": "sheet" | "user" | "default" } }

ALTER TABLE takeoff.rack_rules
  ADD COLUMN rule_key    text,
  ADD COLUMN note_kind   text CHECK (note_kind IN ('coded','drawing','manual')),
  ADD COLUMN note_number integer,
  ADD COLUMN note_text   text,
  ADD COLUMN ru          numeric,
  ADD COLUMN params      jsonb NOT NULL DEFAULT '{}'::jsonb;

-- widen the counting methods
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'takeoff.rack_rules'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%qty_rule%'
  LOOP EXECUTE format('ALTER TABLE takeoff.rack_rules DROP CONSTRAINT %I', c); END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'takeoff.rack_rules'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%zone%'
  LOOP EXECUTE format('ALTER TABLE takeoff.rack_rules DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE takeoff.rack_rules ADD CONSTRAINT rack_rules_qty_rule_check CHECK (qty_rule IN (
  'per_rack','racks_plus_one','per_tr','strands_div_cassette','schedule_div_racks','terminations_div_ports',
  'per_panel','unused_ru','per_wall_mount','layout','none','not_stated','per_elevation'));
ALTER TABLE takeoff.rack_rules ADD CONSTRAINT rack_rules_zone_check CHECK (zone IN ('top','middle','bottom','side'));
ALTER TABLE takeoff.rack_rules ADD CONSTRAINT rack_rules_project_rule_key UNIQUE (project_id, rule_key);

ALTER TABLE takeoff.rack_elevations
  ADD COLUMN title            text,
  ADD COLUMN capacity_passive integer,
  ADD COLUMN capacity_active  integer,
  ADD COLUMN active_over      boolean,
  ADD COLUMN capacity_text    text;
ALTER TABLE takeoff.rack_elevations ADD CONSTRAINT rack_elevations_page_detail UNIQUE (project_id, page_id, detail_ref);
