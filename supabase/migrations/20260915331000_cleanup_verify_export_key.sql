-- Cleans up the temporary key generated in 20260915330000 for live-
-- testing export-sites/export-workers (both confirmed working against
-- real data: 1 real site, 1 real employee returned correctly).
delete from api_keys where name = 'TEMP-VERIFY-export-sites-workers';
