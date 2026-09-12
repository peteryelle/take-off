-- page_regions already stores exactly what a TR room crop box needs
-- (x0/y0/x1/y1, label, page_id) -- it just never had a kind for this use.
-- Deliberately a THIRD kind, not reusing 'schematic': a schematic region
-- (multi-page.html's "+ Add schematic") also registers into distance-
-- routing scope as a side effect of being confirmed. A TR room crop box
-- must NOT do that -- "no distance measures, only the cable-tray run"
-- (chat) -- so it needs its own kind precisely so nothing downstream ever
-- conflates the two and pulls a tr_room box into scope-based routing logic.
ALTER TABLE page_regions DROP CONSTRAINT IF EXISTS page_regions_kind_check;
ALTER TABLE page_regions ADD CONSTRAINT page_regions_kind_check
  CHECK (kind IN ('schematic', 'exclude', 'tr_room'));
