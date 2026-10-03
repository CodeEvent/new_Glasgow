-- 006_venue_map (DOWN)
DROP TABLE IF EXISTS venue_map;
DELETE FROM app_settings WHERE key = 'map_blocks';
