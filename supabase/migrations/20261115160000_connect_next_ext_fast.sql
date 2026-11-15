-- Connect (2026-11-15, found by the payroll load test): adding many people at once had become very slow - 1,000
-- employees took 14 minutes instead of under a second. prosm_time_connect_next_ext scanned every number from 10 to
-- 999,999 (min() over the whole series; the limit applied after it) for each new person. Same result now - the
-- smallest free extension from 10 - found from the extensions that exist: 10 if free, else the first taken number
-- whose next number is free.
-- Rollback: re-run prosm_time_connect_next_ext from 20261114100000.

begin;

create or replace function public.prosm_time_connect_next_ext(p_org uuid)
returns text
language sql
volatile
security definer
set search_path = public
as $$
    select case
        when not exists (select 1 from connect_extensions where organization_id = p_org and ext = '10') then '10'
        else (
            select (x.ext::int + 1)::text
            from connect_extensions x
            where x.organization_id = p_org and x.ext ~ '^[0-9]{2,6}$' and x.ext::int between 10 and 999998
              and not exists (select 1 from connect_extensions y where y.organization_id = p_org and y.ext = (x.ext::int + 1)::text)
            order by x.ext::int
            limit 1
        )
    end;
$$;
revoke all on function public.prosm_time_connect_next_ext(uuid) from public, anon, authenticated;

commit;
