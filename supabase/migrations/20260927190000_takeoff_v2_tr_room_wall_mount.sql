-- WF5: a TR can be marked wall-mount (stored as category 'wall_mount', quantity 1).
-- WF6's per-wall-mount rules (e.g. a wall-mount cabinet note) count these TRs.
ALTER TABLE takeoff.tr_room_devices DROP CONSTRAINT IF EXISTS tr_room_devices_category_check;
ALTER TABLE takeoff.tr_room_devices ADD CONSTRAINT tr_room_devices_category_check CHECK (category IN (
  'rack_new','rack_existing','wire_manager','access_control','backboard','cable_tray',
  'camera_connection','ground_busbar','motion_sensor','sleeves','wall_mount'));
