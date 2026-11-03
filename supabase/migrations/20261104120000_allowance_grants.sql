-- 20261104100000 recreated the allowance save with its new site arguments; a new function
-- is executable by PUBLIC by default. It is for signed-in people only (audit 5.1).
revoke all on function public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, boolean) from public, anon;
grant execute on function public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, boolean) to authenticated;
revoke all on function public.reprice_prosm_time_allowances(date, date) from public, anon;
grant execute on function public.reprice_prosm_time_allowances(date, date) to authenticated;
