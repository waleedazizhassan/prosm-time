-- Owner 2026-11-12: "the absent card still counts people before their shift time" - at 6 in the morning
-- 19 of 21 were absent. Someone due today is absent once their roster shift started, else their site's
-- late start (else its shift start), else the no-site hours. When none of these is set (a site without
-- hours, a person with no site and no no-site hours) the rule fell back to midnight, so everyone was
-- absent from 00:00. Now it falls back to the earliest late start among the organisation's sites, and
-- when no hours are set anywhere the person is not absent today before the day ends (past days still
-- count). Everything that uses the rule follows: the dashboard card and its list, the sites table, the
-- daily summary, the profile and automatic violations.
-- Rollback: restore prosm_time_absent_today from 20261109100000 with the 20261111100000 patch.

begin;

do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_absent_today(uuid,date,text)'::regprocedure);
    a text := 'and ((p_today + coalesce(';
    b text := '                time ''00:00''))::timestamp at time zone p_tz) <= now();';
begin
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    if position(a in v_def) = 0 then raise exception 'absent start anchor a not found'; end if;
    if position(b in v_def) = 0 then raise exception 'absent start anchor b not found'; end if;
    v_def := replace(v_def, a, 'and coalesce((p_today + coalesce(');
    v_def := replace(v_def, b,
        '                (select min(coalesce(x.late_deduction_start_time, x.shift_start_time)) from sites x
                 where x.organization_id = (select organization_id from users where id = p_user) and x.is_active)
             ))::timestamp at time zone p_tz,
             -- no hours anywhere: not absent before the day ends
             (p_today + 1)::timestamp at time zone p_tz) <= now();');
    execute v_def;
end;
$patch$;
revoke all on function public.prosm_time_absent_today(uuid, date, text) from public, anon, authenticated;

commit;
