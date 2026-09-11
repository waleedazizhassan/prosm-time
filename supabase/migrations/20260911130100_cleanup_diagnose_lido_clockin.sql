-- Cleanup for 20260911130000 - the diagnostic RPC has served its
-- purpose (found the real cause: the org's only 2 sites are leftover
-- QA test sites from an earlier this-session pass, not real
-- production sites - geofencing against fake test coordinates is why
-- clock-in "fails" for a site-assigned account).
drop function if exists public.diagnose_lido_clockin_issue();
