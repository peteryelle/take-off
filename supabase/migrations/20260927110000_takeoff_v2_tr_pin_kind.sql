-- Take-Off v2 — Migration 7b: TR pin kinds (serving | exit | off_sheet)
-- The old app uses off-sheet pins (no page, no coordinates, a fixed stub_ft)
-- and per-page exit pins. tr_pins required coordinates, so off-sheet pins
-- could not be stored. Coordinates stay required for every pin on a sheet.

ALTER TABLE takeoff.tr_pins
  ADD COLUMN pin_kind text NOT NULL DEFAULT 'serving'
    CHECK (pin_kind IN ('serving','exit','off_sheet'));
ALTER TABLE takeoff.tr_pins ALTER COLUMN x_norm DROP NOT NULL;
ALTER TABLE takeoff.tr_pins ALTER COLUMN y_norm DROP NOT NULL;
ALTER TABLE takeoff.tr_pins ADD CONSTRAINT tr_pins_coords_unless_off_sheet
  CHECK (pin_kind = 'off_sheet' OR (x_norm IS NOT NULL AND y_norm IS NOT NULL));
CREATE INDEX idx_to_tr_pins_page_kind ON takeoff.tr_pins(page_id, pin_kind);

-- confirm
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema='takeoff' AND table_name='tr_pins' AND column_name IN ('pin_kind','x_norm','y_norm');
