-- Take-Off v2 — Migration 7d: correct per-mode multiplier defaults
-- straight 1.35 (default mode), right_angle 1.20, routed 1.10.
-- Projects still holding the untouched previous defaults are moved to the
-- new ones; any value a user actually set is left alone.

ALTER TABLE takeoff.projects ALTER COLUMN straight_multiplier SET DEFAULT 1.35;
ALTER TABLE takeoff.projects ALTER COLUMN right_angle_multiplier SET DEFAULT 1.20;
ALTER TABLE takeoff.projects ALTER COLUMN routed_multiplier   SET DEFAULT 1.10;

UPDATE takeoff.projects SET straight_multiplier = 1.35 WHERE straight_multiplier = 1.00;
UPDATE takeoff.projects SET right_angle_multiplier = 1.20 WHERE right_angle_multiplier = 1.00;
UPDATE takeoff.projects SET routed_multiplier   = 1.10 WHERE routed_multiplier   = 1.35;

-- confirm
SELECT id, route_mode, straight_multiplier, right_angle_multiplier, routed_multiplier FROM takeoff.projects ORDER BY id;
