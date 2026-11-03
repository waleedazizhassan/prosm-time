-- 2026-11-03 (owner): "the morning summary arrived but tapping it goes nowhere; it should
-- open a Daily summaries page in the side menu, organised by day." One day of the whole
-- organisation, for the owner, computed live for any date (not only from the morning
-- message): who worked and for how long, who came late, who missed a scheduled shift,
-- who was on leave, and what is waiting for a decision now. Days are counted in each
-- site's time zone, the same way as the morning summary.
-- Rollback: drop function get_prosm_time_daily_summary(date).

begin;

create or replace function public.get_prosm_time_daily_summary(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_result jsonb;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN SEE THE DAILY SUMMARY'; end if;
    if p_date is null then raise exception 'A DATE IS REQUIRED'; end if;

    with day_sessions as (
        select a.*, public.prosm_time_site_timezone(a.site_id, a.organization_id) as tz
        from attendance_sessions a
        where a.organization_id = v_org
          and a.clock_in_at >= (p_date - 2)::timestamp and a.clock_in_at < (p_date + 2)::timestamp
          and public.prosm_time_work_date(a.clock_in_at, a.site_id, a.organization_id) = p_date
    ),
    breaks as (
        select b.attendance_session_id, sum(extract(epoch from (coalesce(b.ended_at, now()) - b.started_at)) / 60) as minutes
        from break_events b where b.attendance_session_id in (select id from day_sessions) and not coalesce(b.paid, false)
        group by 1
    ),
    per_person as (
        select s.user_id,
               min(s.clock_in_at) as first_in,
               max(s.clock_out_at) as last_out,
               bool_or(s.status = 'clocked_in') as still_in,
               bool_or(coalesce(s.auto_closed, false)) as auto_closed,
               round(sum(greatest(0, extract(epoch from (coalesce(s.clock_out_at, now()) - s.clock_in_at)) / 60 - coalesce(br.minutes, 0))))::int as minutes,
               (array_agg(s.site_id order by s.clock_in_at))[1] as site_id,
               (array_agg(s.tz order by s.clock_in_at))[1] as tz
        from day_sessions s left join breaks br on br.attendance_session_id = s.id
        group by s.user_id
    ),
    planned as (
        -- the shift the person had that day: their roster first, else their site's hours
        select p.user_id,
               coalesce((select sa.start_time from shift_assignments sa where sa.user_id = p.user_id and sa.shift_date = p_date and sa.status = 'scheduled' order by sa.start_time limit 1), st.shift_start_time) as start_time,
               coalesce(st.grace_tolerance_minutes, 0) as grace
        from per_person p left join sites st on st.id = p.site_id
    ),
    worked as (
        select p.*, u.full_name, st.name as site_name,
               case when pl.start_time is not null
                     and (p.first_in at time zone p.tz)::time > pl.start_time + make_interval(mins => pl.grace)
                    then round(extract(epoch from ((p.first_in at time zone p.tz)::time - pl.start_time)) / 60)::int end as late_minutes
        from per_person p
        join users u on u.id = p.user_id
        left join sites st on st.id = p.site_id
        left join planned pl on pl.user_id = p.user_id
    ),
    on_leave as (
        select lr.user_id, u.full_name, coalesce(lt.name, lr.leave_type) as leave_name
        from leave_requests lr
        join users u on u.id = lr.user_id
        left join leave_types lt on lt.organization_id = lr.organization_id and lt.key = lr.leave_type
        where lr.organization_id = v_org and lr.status = 'approved' and p_date between lr.start_date and lr.end_date
    ),
    no_shows as (
        select sa.user_id, u.full_name, st.name as site_name, sa.start_time, sa.end_time
        from shift_assignments sa
        join users u on u.id = sa.user_id and u.is_active
        left join sites st on st.id = sa.site_id
        where sa.organization_id = v_org and sa.shift_date = p_date and sa.status = 'scheduled'
          and not exists (select 1 from per_person p where p.user_id = sa.user_id)
          and not exists (select 1 from on_leave l where l.user_id = sa.user_id)
    )
    select jsonb_build_object(
        'date', p_date,
        'worked', (select count(*) from worked),
        'minutes', coalesce((select sum(minutes) from worked), 0),
        'late', (select count(*) from worked where late_minutes is not null),
        'noShows', (select count(*) from no_shows),
        'onLeave', (select count(*) from on_leave),
        'people', coalesce((select jsonb_agg(jsonb_build_object(
                'userId', w.user_id, 'name', w.full_name, 'site', w.site_name, 'firstIn', w.first_in, 'lastOut', w.last_out,
                'stillIn', w.still_in, 'autoClosed', w.auto_closed, 'minutes', w.minutes, 'lateMinutes', w.late_minutes, 'timezone', w.tz)
                order by w.full_name) from worked w), '[]'::jsonb),
        'noShowList', coalesce((select jsonb_agg(jsonb_build_object('userId', n.user_id, 'name', n.full_name, 'site', n.site_name,
                'start', to_char(n.start_time, 'HH24:MI'), 'end', to_char(n.end_time, 'HH24:MI')) order by n.full_name) from no_shows n), '[]'::jsonb),
        'leaveList', coalesce((select jsonb_agg(jsonb_build_object('userId', l.user_id, 'name', l.full_name, 'leave', l.leave_name) order by l.full_name) from on_leave l), '[]'::jsonb),
        'waiting', jsonb_build_object(
            'leave', (select count(*) from leave_requests lr where lr.organization_id = v_org and lr.status = 'pending'),
            'exceptions', (select count(*) from geofence_exceptions ge where ge.organization_id = v_org and ge.status = 'pending_review'),
            'clockedInNow', (select count(*) from attendance_sessions a where a.organization_id = v_org and a.status = 'clocked_in'))
    ) into v_result;

    return v_result;
end;
$$;
revoke all on function public.get_prosm_time_daily_summary(date) from public, anon;
grant execute on function public.get_prosm_time_daily_summary(date) to authenticated;

commit;
