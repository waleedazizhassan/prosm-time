-- 2026-11-09 (owner: "review every KPI card and make sure it works right"). Faults in the "today"
-- figures, found in the review:
--   1. Who worked today and who was late today were taken from the sessions of the chosen period,
--      so with a period that does not include today (last month, a past range) everybody showed
--      as absent today and nobody as late. Today's figures now come from today's sessions only.
--   2. Without a schedule, every member who had not clocked in was absent - on the weekly rest day
--      too. Now only a working day of the person's own calendar (site or organisation rest days,
--      public holidays, a day off) can make someone absent; with a schedule, a scheduled shift.
--   3. Someone whose day had not started yet (a shift at 9, looked at 7) was already absent. Now
--      the day must have started: the first scheduled shift's start, else the site's start time.
--   4. The light overview card counted as absent everyone not clocked in right now - including
--      people who had worked and clocked out today.
-- One rule, prosm_time_absent_today, now serves the dashboard card, its list, the sites table and
-- the overview card, so they always agree. Nothing else changes.

begin;

-- Absent today: expected to work today (a scheduled shift, or - for someone not on the schedule
-- around today - a working day of their calendar), the day has started, no attendance on that work
-- day, no approved leave, not a public holiday.
create or replace function public.prosm_time_absent_today(p_user uuid, p_today date, p_tz text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        not exists (
            select 1 from attendance_sessions s
            where s.user_id = p_user
              and s.clock_in_at >= ((p_today - 1)::timestamp at time zone p_tz) and s.clock_in_at < ((p_today + 2)::timestamp at time zone p_tz)
              and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_today)
        and not exists (select 1 from leave_requests l where l.user_id = p_user and l.status = 'approved' and p_today between l.start_date and l.end_date)
        and not exists (
            select 1 from public_holidays h join users u on u.id = p_user
            where h.organization_id = u.organization_id and p_today between h.start_date and h.end_date
              and (h.site_id is null or h.site_id in (select x.site_id from site_assignments x where x.user_id = p_user)))
        and case
            when exists (select 1 from shift_assignments sa where sa.user_id = p_user and sa.status = 'scheduled' and sa.shift_date between p_today - 6 and p_today + 6)
                then exists (select 1 from shift_assignments sa where sa.user_id = p_user and sa.status = 'scheduled' and sa.shift_date = p_today)
            else exists (select 1 from public.prosm_time_leave_days(p_user, p_today, p_today) d where d.day_type = 'workday')
        end
        and ((p_today + coalesce(
                (select min(sa.start_time) from shift_assignments sa where sa.user_id = p_user and sa.status = 'scheduled' and sa.shift_date = p_today),
                (select st.shift_start_time from sites st where st.id = public.prosm_time_calendar_site(p_user)),
                time '00:00'))::timestamp at time zone p_tz) <= now();
$$;
revoke all on function public.prosm_time_absent_today(uuid, date, text) from public, anon, authenticated;

-- The dashboard
do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_manager_dashboard(date, date, text, uuid, text)'::regprocedure);
    v_from integer;
    v_to integer;
    v_pairs text[][] := array[
        array[
            '    worked_today as (select distinct user_id from period_sessions where work_date = v_today),',
            '    worked_today as (
        select distinct s.user_id from attendance_sessions s
        where s.user_id = any(v_team)
          and s.clock_in_at >= ((v_today - 1)::timestamp at time zone v_tz) and s.clock_in_at < ((v_today + 2)::timestamp at time zone v_tz)
          and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = v_today
    ),'
        ],
        array[
            '    late_today as (select user_id from summaries where work_date = v_today and (s ->> ''lateMinutes'')::numeric > 0),',
            '    today_summaries as (select w.user_id, public.prosm_time_day_summary(w.user_id, v_today) as s from worked_today w),
    late_today as (select user_id from today_summaries where (s ->> ''lateMinutes'')::numeric > 0),'
        ],
        array[
            '''late'', (select count(*) from summaries sm where sm.work_date = v_today and (sm.s ->> ''siteId'')::uuid = st.id and (sm.s ->> ''lateMinutes'')::numeric > 0),',
            '''late'', (select count(*) from today_summaries sm where (sm.s ->> ''siteId'')::uuid = st.id and (sm.s ->> ''lateMinutes'')::numeric > 0),'
        ],
        array[
            'and sa.user_id not in (select user_id from worked_today) and sa.user_id not in (select user_id from on_leave_today)),',
            'and sa.user_id in (select user_id from absent_today)),'
        ]
    ];
    i integer;
begin
    -- the absent_today CTE, whole, becomes the shared rule
    v_from := position('    absent_today as (' in v_def);
    v_to := position('    late_today as (' in v_def);
    if v_from = 0 or v_to = 0 or v_to < v_from then raise exception 'dashboard today figures: absent_today not found'; end if;
    v_def := substring(v_def from 1 for v_from - 1)
        || '    absent_today as (select t.id as user_id from team t where public.prosm_time_absent_today(t.id, v_today, v_tz)),' || chr(10)
        || substring(v_def from v_to);
    for i in 1 .. array_length(v_pairs, 1) loop
        if position(v_pairs[i][1] in v_def) = 0 then
            raise exception 'dashboard today figures: anchor % not found', i;
        end if;
        v_def := replace(v_def, v_pairs[i][1], v_pairs[i][2]);
    end loop;
    execute v_def;
end $$;

-- The overview card
do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_dashboard_summary(date, text)'::regprocedure);
    v_old text := '''absent'', greatest(0, (select count(*) from team) - (select count(*) from present) - (select count(*) from on_leave)),';
begin
    if position(v_old in v_def) = 0 then raise exception 'dashboard summary: absent not found'; end if;
    execute replace(v_def, v_old, '''absent'', (select count(*) from team t where public.prosm_time_absent_today(t.id, v_today, v_tz)),');
end $$;

commit;
