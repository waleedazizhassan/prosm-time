-- 2026-11-10 (owner): "keep the shift start and end, the overtime start and the late start; remove the
-- grace period entirely, and everything that follows from it. And under 'outside the sites' set the shift
-- start and end, the overtime start and the late start - optional: left without hours is fine."
--   1. The grace period is gone: every site's and the organisation default's grace is 0, and nothing adds
--      it any more. Lateness counts from the site's "late deductions start at" time when it has one, else
--      from its shift start (a roster shift: from its own start) - the same in the day's figures (and so
--      payroll), the daily summary, the dashboard and the late report. "Block self clock-in" (its
--      setting keeps its name in the database) blocks after that same time.
--   2. Outside the sites: the organisation's optional shift start / end, overtime start and late start
--      for a clock-in with no site (organization_settings.no_site_*). Empty = no hours, as before.
-- Rollback: restore prosm_time_day_summary, get_prosm_time_daily_summary, list_prosm_time_report_late
-- and clock_in_prosm_time_attendance from their previous migrations and prosm_time_late_today from
-- 20261110150000; drop prosm_time_late_from, set_prosm_time_no_site_hours and the no_site_* columns.
-- The grace values set to 0 are not kept.

begin;

-- 1. no grace
update public.sites set grace_tolerance_minutes = 0 where grace_tolerance_minutes <> 0;
update public.organization_settings set default_grace_tolerance_minutes = 0 where default_grace_tolerance_minutes <> 0;
alter table public.sites alter column grace_tolerance_minutes set default 0;
alter table public.organization_settings alter column default_grace_tolerance_minutes set default 0;

-- and it stays 0 whatever an older app sends
create or replace function public.prosm_time_no_grace()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.grace_tolerance_minutes := 0;
    return new;
end;
$$;
revoke all on function public.prosm_time_no_grace() from public, anon, authenticated;
drop trigger if exists sites_no_grace on public.sites;
create trigger sites_no_grace before insert or update of grace_tolerance_minutes on public.sites
for each row execute function public.prosm_time_no_grace();

-- 2. outside the sites: optional hours
alter table public.organization_settings
    add column if not exists no_site_shift_start_time time,
    add column if not exists no_site_shift_end_time time,
    add column if not exists no_site_overtime_start_time time,
    add column if not exists no_site_late_deduction_start_time time;

-- the time lateness counts from, for a site (or, with no site, the organisation's outside-the-sites hours)
create or replace function public.prosm_time_late_from(p_site uuid, p_org uuid)
returns time
language sql
stable
security definer
set search_path = public
as $$
    select case
        when p_site is not null then (select coalesce(late_deduction_start_time, shift_start_time) from sites where id = p_site)
        else (select coalesce(no_site_late_deduction_start_time, no_site_shift_start_time) from organization_settings where organization_id = p_org)
    end;
$$;
revoke all on function public.prosm_time_late_from(uuid, uuid) from public, anon, authenticated;

create or replace function public.set_prosm_time_no_site_hours(p_shift_start time, p_shift_end time, p_overtime_start time, p_late_start time)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE ORGANIZATION OWNER MAY SET THE NO-SITE HOURS'; end if;
    update organization_settings set
        no_site_shift_start_time = p_shift_start,
        no_site_shift_end_time = p_shift_end,
        no_site_overtime_start_time = p_overtime_start,
        no_site_late_deduction_start_time = p_late_start
    where organization_id = v_org;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_no_site_hours(time, time, time, time) from public, anon;
grant execute on function public.set_prosm_time_no_site_hours(time, time, time, time) to authenticated;

do $patch$
declare
    v_def text;
    a text;
begin
    -- the day's figures (timesheets, payroll): a roster shift counts from its start (no grace); a day with
    -- no site takes the organisation's outside-the-sites hours
    v_def := pg_get_functiondef('public.prosm_time_day_summary(uuid,date)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));  -- some were written with Windows line ends
    v_def := replace(v_def, E'
', E'
');  -- some were written with Windows line ends
    a := 'case when v_assignment.id is not null then v_assignment.start_time + make_interval(mins => coalesce(v_site_row.grace_tolerance_minutes, 0)) end,';
    if position(a in v_def) = 0 then raise exception 'day summary grace anchor not found'; end if;
    v_def := replace(v_def, a, 'case when v_assignment.id is not null then v_assignment.start_time end,');
    a := '    select * into v_site_row from sites where id = v_site;';
    if position(a in v_def) = 0 then raise exception 'day summary site anchor not found'; end if;
    v_def := replace(v_def, a, a || '
    -- 2026-11-10: a day with no site follows the organisation''s outside-the-sites hours (all optional)
    if v_site is null then
        select no_site_shift_start_time, no_site_shift_end_time, no_site_overtime_start_time, no_site_late_deduction_start_time
        into v_site_row.shift_start_time, v_site_row.shift_end_time, v_site_row.overtime_start_time, v_site_row.late_deduction_start_time
        from organization_settings where organization_id = v_org;
    end if;');
    execute v_def;

    -- the daily summary: late from the late start (else the shift start), no grace
    v_def := pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));  -- some were written with Windows line ends
    v_def := replace(v_def, E'
', E'
');  -- some were written with Windows line ends
    a := 'order by sa.start_time limit 1), st.shift_start_time) as start_time,
               coalesce(st.grace_tolerance_minutes, 0) as grace';
    if position(a in v_def) = 0 then raise exception 'daily summary anchor not found'; end if;
    v_def := replace(v_def, a, 'order by sa.start_time limit 1), public.prosm_time_late_from(p.site_id, v_org)) as start_time,
               0 as grace');
    execute v_def;

    -- the late report: from the late start (else the shift start), no grace
    v_def := pg_get_functiondef('public.list_prosm_time_report_late(date,date)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));  -- some were written with Windows line ends
    v_def := replace(v_def, E'
', E'
');  -- some were written with Windows line ends
    a := '            (sess.clock_in_at at time zone coalesce(s.timezone, ''UTC''))::time - s.shift_start_time
        ))::integer / 60 - coalesce(s.grace_tolerance_minutes, 0)';
    if position(a in v_def) = 0 then raise exception 'late report minutes anchor not found'; end if;
    v_def := replace(v_def, a, '            (sess.clock_in_at at time zone coalesce(s.timezone, ''UTC''))::time - coalesce(s.late_deduction_start_time, s.shift_start_time)
        ))::integer / 60');
    a := '      and s.shift_start_time is not null';
    if position(a in v_def) = 0 then raise exception 'late report filter anchor not found'; end if;
    v_def := replace(v_def, a, '      and coalesce(s.late_deduction_start_time, s.shift_start_time) is not null');
    a := '          > (s.shift_start_time + make_interval(mins => coalesce(s.grace_tolerance_minutes, 0)))';
    if position(a in v_def) = 0 then raise exception 'late report compare anchor not found'; end if;
    v_def := replace(v_def, a, '          > coalesce(s.late_deduction_start_time, s.shift_start_time)');
    execute v_def;

    -- "block self clock-in" blocks after the late start (else the shift start)
    v_def := pg_get_functiondef('public.clock_in_prosm_time_attendance(text,uuid,uuid,timestamp with time zone,double precision,double precision,double precision,text,text,text,boolean,boolean)'::regprocedure);
    v_def := replace(v_def, chr(13) || chr(10), chr(10));  -- some were written with Windows line ends
    v_def := replace(v_def, E'
', E'
');  -- some were written with Windows line ends
    a := 'if v_site.block_self_clock_in_after_grace and v_site.shift_start_time is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > (v_site.shift_start_time + make_interval(mins => v_site.grace_tolerance_minutes)) then';
    if position(a in v_def) = 0 then raise exception 'clock-in block anchor not found'; end if;
    v_def := replace(v_def, a, 'if v_site.block_self_clock_in_after_grace and coalesce(v_site.late_deduction_start_time, v_site.shift_start_time) is not null and not v_is_exempt then
            if (now() at time zone v_site.timezone)::time > coalesce(v_site.late_deduction_start_time, v_site.shift_start_time) then');
    execute v_def;
end;
$patch$;

-- the dashboard's "late today": from the roster shift's start, else the late start (else the shift start)
create or replace function public.prosm_time_late_today(p_user uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with first_in as (
        select s.clock_in_at, coalesce(s.site_id, s.responsible_site_id) as site_id, s.organization_id
        from attendance_sessions s
        where s.user_id = p_user
          and s.clock_in_at >= (p_day - 1)::timestamp and s.clock_in_at < (p_day + 2)::timestamp
          and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_day
        order by s.clock_in_at
        limit 1
    ),
    planned as (
        select f.clock_in_at,
               public.prosm_time_site_timezone(f.site_id, f.organization_id) as tz,
               coalesce((select sa.start_time from shift_assignments sa where sa.user_id = p_user and sa.shift_date = p_day and sa.status = 'scheduled' order by sa.start_time limit 1),
                        public.prosm_time_late_from(f.site_id, f.organization_id)) as start_time
        from first_in f
    )
    select coalesce((select (p.clock_in_at at time zone p.tz)::time > p.start_time from planned p where p.start_time is not null), false);
$$;
revoke all on function public.prosm_time_late_today(uuid, date) from public, anon, authenticated;

commit;
