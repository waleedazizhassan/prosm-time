-- 2026-11-11 (owner):
-- 1. "Absent today starts counting from the late start; whoever arrives moves to 'late'." Someone due
--    today is absent once their roster shift has started, else once their site's late start (else its
--    shift start) has passed - not from the shift start. Arriving later makes them late, not absent.
-- 2. "The summary shows only those who missed their shift, not the absent in general - and its
--    notification gives other figures than the page." The daily summary's absent list is everyone
--    absent that day by the same rule as the dashboard (roster or not), and the morning notification is
--    built from the same rules: worked, late, absent, on leave.
-- 3. "A notification that someone left their work area opens the manager page with nothing on it." The
--    app now asks what became of that exception (still waiting for the employee's reason, waiting for
--    review, or decided) and says so.
-- Rollback: restore prosm_time_absent_today from 20261109100000, get_prosm_time_daily_summary from
-- 20261110200000 and process_prosm_time_manager_alerts from 20261102180000; drop
-- get_prosm_time_exception_status(uuid).

begin;

-- 1. absent from the late start
do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_absent_today(uuid,date,text)'::regprocedure);
    a text := '(select st.shift_start_time from sites st where st.id = public.prosm_time_calendar_site(p_user)),';
begin
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    if position(a in v_def) = 0 then raise exception 'absent start anchor not found'; end if;
    v_def := replace(v_def, a, 'public.prosm_time_late_from(public.prosm_time_calendar_site(p_user), (select organization_id from users where id = p_user)),');
    execute v_def;
end;
$patch$;

-- 2. the daily summary's absent: everyone absent that day, by the dashboard's rule
do $patch$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure);
    a text := '    no_shows as (
        select sa.user_id, u.full_name, st.name as site_name, sa.start_time, sa.end_time
        from shift_assignments sa
        join users u on u.id = sa.user_id and u.is_active
        left join sites st on st.id = sa.site_id
        where sa.organization_id = v_org and sa.shift_date = p_date and sa.status = ''scheduled''
          and not exists (select 1 from per_person p where p.user_id = sa.user_id)
          and not exists (select 1 from on_leave l where l.user_id = sa.user_id)
    )';
begin
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    if position(a in v_def) = 0 then raise exception 'no-shows anchor not found'; end if;
    v_def := replace(v_def, a, '    no_shows as (
        -- 2026-11-11: everyone absent that day (roster or not), by the dashboard''s rule
        select u.id as user_id, u.full_name, st.name as site_name,
               coalesce((select min(sa.start_time) from shift_assignments sa where sa.user_id = u.id and sa.shift_date = p_date and sa.status = ''scheduled''), st.shift_start_time) as start_time,
               coalesce((select max(sa.end_time) from shift_assignments sa where sa.user_id = u.id and sa.shift_date = p_date and sa.status = ''scheduled''), st.shift_end_time) as end_time
        from users u
        cross join lateral (select public.prosm_time_calendar_site(u.id) as site_id) cs
        left join sites st on st.id = cs.site_id
        where u.organization_id = v_org and u.is_active and not u.is_owner
          and not exists (select 1 from per_person p where p.user_id = u.id)
          and public.prosm_time_absent_today(u.id, p_date, public.prosm_time_site_timezone(cs.site_id, v_org))
    )');
    execute v_def;
end;
$patch$;

-- the morning notification: the same figures as the page
do $patch$
declare
    v_def text := pg_get_functiondef('public.process_prosm_time_manager_alerts()'::regprocedure);
    a text;
begin
    v_def := replace(v_def, chr(13) || chr(10), chr(10));
    a := '            select count(*) into v_no_shows from manager_alert_log l join shift_assignments sa on sa.id = l.ref_id
            where l.kind = ''no_show'' and l.organization_id = v_row.organization_id and sa.shift_date = v_yesterday;';
    if position(a in v_def) = 0 then raise exception 'digest absent anchor not found'; end if;
    v_def := replace(v_def, a, '            -- 2026-11-11: absent, late and on leave by the daily summary''s rules
            select count(*) into v_no_shows from users u
            where u.organization_id = v_row.organization_id and u.is_active and not u.is_owner
              and not exists (select 1 from attendance_sessions a where a.user_id = u.id and public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) = v_yesterday)
              and public.prosm_time_absent_today(u.id, v_yesterday, public.prosm_time_site_timezone(public.prosm_time_calendar_site(u.id), v_row.organization_id));
            select count(*) into v_late from users u
            where u.organization_id = v_row.organization_id and u.is_active and not u.is_owner
              and public.prosm_time_late_today(u.id, v_yesterday);
            select count(distinct lr.user_id) into v_on_leave from leave_requests lr
            where lr.organization_id = v_row.organization_id and lr.status = ''approved'' and v_yesterday between lr.start_date and lr.end_date;');
    a := '            v_exceptions integer;
        begin';
    if position(a in v_def) = 0 then raise exception 'digest declare anchor not found'; end if;
    v_def := replace(v_def, a, '            v_exceptions integer;
            v_late integer;
            v_on_leave integer;
        begin');
    a := 'jsonb_build_object(''date'', v_yesterday, ''present'', v_present, ''noShows'', v_no_shows,';
    if position(a in v_def) = 0 then raise exception 'digest data anchor not found'; end if;
    v_def := replace(v_def, a, 'jsonb_build_object(''date'', v_yesterday, ''present'', v_present, ''noShows'', v_no_shows, ''absent'', v_no_shows, ''late'', v_late, ''onLeave'', v_on_leave,');
    a := '''Yesterday at a glance'',
                    v_present || '' worked, '' || v_no_shows || '' missed a shift.';
    if position(a in v_def) = 0 then raise exception 'digest text anchor not found'; end if;
    v_def := replace(v_def, a, '''Yesterday at a glance'',
                    v_present || '' worked, '' || v_late || '' late, '' || v_no_shows || '' absent, '' || v_on_leave || '' on leave.');
    execute v_def;
end;
$patch$;

-- 3. what became of an out-of-area exception (for whoever has authority over the person)
create or replace function public.get_prosm_time_exception_status(p_exception_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_row geofence_exceptions%rowtype;
begin
    select * into v_row from geofence_exceptions where id = p_exception_id and organization_id = public.current_prosm_time_organization_id();
    if v_row.id is null then return jsonb_build_object('found', false); end if;
    if not (public.current_prosm_time_user_is_owner() or public.prosm_time_caller_has_authority_over(v_row.user_id)) then
        return jsonb_build_object('found', false);
    end if;
    return jsonb_build_object('found', true, 'status', v_row.status, 'userId', v_row.user_id,
        'employeeName', (select full_name from users where id = v_row.user_id),
        'distanceMeters', round(coalesce(v_row.distance_meters, 0)::numeric), 'createdAt', v_row.created_at);
end;
$$;
revoke all on function public.get_prosm_time_exception_status(uuid) from public, anon;
grant execute on function public.get_prosm_time_exception_status(uuid) to authenticated;

commit;
