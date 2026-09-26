-- Take-Off v2 — Migration 7c: one multiplier per routing mode
-- The user picks a mode (straight line is the default) and sets the multiplier
-- for each mode. Routed defaults to 1.35 so today's validated routed lengths
-- are unchanged until someone edits it. A sheet can still override its mode
-- and multiplier (pages.route_mode / pages.route_multiplier).

ALTER TABLE takeoff.projects
  ADD COLUMN straight_multiplier    numeric NOT NULL DEFAULT 1.00 CHECK (straight_multiplier > 0),
  ADD COLUMN right_angle_multiplier numeric NOT NULL DEFAULT 1.00 CHECK (right_angle_multiplier > 0),
  ADD COLUMN routed_multiplier      numeric NOT NULL DEFAULT 1.35 CHECK (routed_multiplier > 0);
ALTER TABLE takeoff.projects DROP COLUMN route_multiplier;

-- confirm
SELECT column_name, column_default FROM information_schema.columns
WHERE table_schema='takeoff' AND table_name='projects' AND column_name LIKE '%multiplier' ORDER BY 1;
