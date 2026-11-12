-- Screens review 2026-11-12 (the dashboard timed out): the dashboards, the audit log and the open-session screens
-- checked the reader's time zone against pg_timezone_names, a view that reads every time zone file on each call.
-- A time zone is now checked by using it (the same names are accepted; anything else falls back as before).
-- Rollback: restore each function from pg_get_functiondef before this migration
-- (public.prosm_time_tz_or(p_time_zone, X) back to the pg_timezone_names lookup); drop function prosm_time_tz_or.

begin;

create or replace function public.prosm_time_tz_or(p_tz text, p_default text)
returns text
language plpgsql
stable
set search_path = public
as $function$
begin
    if p_tz is null or p_tz = '' then return p_default; end if;
    perform now() at time zone p_tz;
    return p_tz;
exception
    when others then return p_default;
end;
$function$;
revoke all on function public.prosm_time_tz_or(text, text) from public, anon;
grant execute on function public.prosm_time_tz_or(text, text) to authenticated, service_role;

do $$
declare
    v_fn record;
    v_def text;
    v_new text;
    v_count integer := 0;
begin
    for v_fn in
        select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%from pg_timezone_names where name = p_time_zone limit 1%'
    loop
        v_def := pg_get_functiondef(v_fn.oid);
        v_new := regexp_replace(v_def,
            'coalesce\(\(select name from pg_timezone_names where name = p_time_zone limit 1\), (''[^'']+'')\)',
            'public.prosm_time_tz_or(p_time_zone, \1)', 'g');
        if v_new <> v_def then
            execute v_new;
            v_count := v_count + 1;
        end if;
    end loop;
    if v_count = 0 then raise exception 'no time zone lookup found'; end if;
    raise notice 'time zone check replaced in % functions', v_count;
end $$;

commit;
