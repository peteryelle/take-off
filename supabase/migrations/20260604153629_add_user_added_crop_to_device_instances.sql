-- Support add-by-crop: when the user boxes in a device the detector missed, store the
-- cropped symbol image and mark provenance so it's never confused with a machine
-- detection. detection_method = 'user_added' carries the provenance; source_crop_base64
-- holds the crop (same format as device_types.example_image_base64).
alter table device_instances add column if not exists source_crop_base64 text;
