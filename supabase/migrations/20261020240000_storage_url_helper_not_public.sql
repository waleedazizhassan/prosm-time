-- The URL check helper of 20261020210000 is only used inside the logo and
-- avatar front doors; like every internal helper it is not callable from the
-- API (the anon allow-list test caught it).
revoke all on function public.prosm_time_is_own_storage_url(text, text) from public, anon, authenticated;
