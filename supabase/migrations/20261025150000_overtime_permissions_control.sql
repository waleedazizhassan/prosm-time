-- PROSM Time v2.3.43, step 6 (item 23): management controls overtime,
-- deductions and permissions. One calculation of a person's work day,
-- prosm_time_day_summary(user, day), now feeds both timesheets and
-- allowances, so the two never disagree:
--   a) attendance permissions on a day (attendance_permissions):
--      late_arrival (no lateness/deduction), early_leave (no deduction),
--      approved_overtime (the overtime counts), no_overtime (the extra time
--      does not count even if the person stayed); each paid or with a
--      partial deduction (percent or minutes). Asked in advance by the
--      employee and approved by a manager, or added afterwards by a
--      manager, as long as the period is not approved;
--   b) overtime policy (overtime_policies, organisation, site or shift
--      template): "automatic" or "needs a manager's approval" (the default,
--      owner decision), minimum minutes before overtime / lateness count,
--      maximum overtime per day;
--   c) multipliers per kind of day: normal, night, weekly rest day, public
--      holiday - seeded at 1.0, which is today's behaviour, so nothing
--      changes until the Owner sets them;
--   d) break rules per shift template: paid or unpaid, maximum minutes, an
--      automatic deduction when no break was taken;
--   e) a manager's manual adjustment of a day (overtime, lateness or
--      deduction minutes, or approving the day's overtime), reason required,
--      audited, before the period is approved only;
--   g) attendance.manage_permissions (Owner, Managers at their sites).

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('attendance.manage_permissions', 'attendance', 'APPROVE', 'Permissions, overtime approval and day adjustments',
        'Grant or approve attendance permissions, approve overtime and adjust a day''s minutes for people at the sites one manages.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'attendance.manage_permissions'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

-- ------------------------------------------------------------------
-- b) + c) overtime policy
-- ------------------------------------------------------------------
create table if not exists public.overtime_policies (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid references public.sites(id) on delete cascade,
    shift_template_id uuid references public.shift_templates(id) on delete cascade,
    approval_mode text check (approval_mode in ('automatic', 'approval')),
    min_overtime_minutes integer check (min_overtime_minutes between 0 and 600),
    min_late_minutes integer check (min_late_minutes between 0 and 600),
    max_daily_overtime_minutes integer check (max_daily_overtime_minutes between 0 and 1440),
    multiplier_normal numeric check (multiplier_normal between 0 and 10),
    multiplier_night numeric check (multiplier_night between 0 and 10),
    multiplier_weekly_rest numeric check (multiplier_weekly_rest between 0 and 10),
    multiplier_public_holiday numeric check (multiplier_public_holiday between 0 and 10),
    night_start time,
    night_end time,
    updated_by uuid references public.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    check (num_nonnulls(site_id, shift_template_id) <= 1)
);
create unique index if not exists overtime_policies_scope_idx on public.overtime_policies (
    organization_id,
    coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(shift_template_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

alter table public.overtime_policies enable row level security;
revoke all on public.overtime_policies from anon, authenticated;
grant select on public.overtime_policies to authenticated;
drop policy if exists "overtime policies visible to the organisation" on public.overtime_policies;
create policy "overtime policies visible to the organisation" on public.overtime_policies
for select to authenticated using (organization_id = public.current_prosm_time_organization_id());

-- d) break rules per shift template
alter table public.shift_templates add column if not exists break_paid boolean not null default true;
alter table public.shift_templates add column if not exists break_max_minutes integer check (break_max_minutes between 1 and 600);
alter table public.shift_templates add column if not exists break_auto_deduct_minutes integer check (break_auto_deduct_minutes between 1 and 600);

-- ------------------------------------------------------------------
-- a) attendance permissions
-- ------------------------------------------------------------------
create table if not exists public.attendance_permissions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    work_date date not null,
    kind text not null check (kind in ('late_arrival', 'early_leave', 'approved_overtime', 'no_overtime')),
    minutes integer check (minutes between 1 and 1440),
    paid boolean not null default true,
    deduction_percent numeric check (deduction_percent between 0 and 100),
    deduction_minutes integer check (deduction_minutes between 0 and 1440),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
    retroactive boolean not null default false,
    reason text not null check (length(trim(reason)) between 1 and 500),
    requested_by uuid references public.users(id) on delete set null,
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists attendance_permissions_user_day_idx on public.attendance_permissions (user_id, work_date);
create index if not exists attendance_permissions_pending_idx on public.attendance_permissions (organization_id) where status = 'pending';

alter table public.attendance_permissions enable row level security;
revoke all on public.attendance_permissions from anon, authenticated;
grant select on public.attendance_permissions to authenticated;
drop policy if exists "attendance permissions visible to the person or their managers" on public.attendance_permissions;
create policy "attendance permissions visible to the person or their managers" on public.attendance_permissions
for select to authenticated using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id = public.current_prosm_time_user_id() or public.prosm_time_caller_sees_person(user_id))
);

-- e) manual adjustments of a day (history kept; the latest is in force)
create table if not exists public.attendance_day_adjustments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    work_date date not null,
    overtime_minutes numeric check (overtime_minutes >= 0),
    late_minutes numeric check (late_minutes >= 0),
    deduction_minutes numeric check (deduction_minutes >= 0),
    overtime_approved boolean,
    reason text not null check (length(trim(reason)) between 1 and 500),
    actor_user_id uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create index if not exists attendance_day_adjustments_user_day_idx on public.attendance_day_adjustments (user_id, work_date, created_at desc);

alter table public.attendance_day_adjustments enable row level security;
revoke all on public.attendance_day_adjustments from anon, authenticated;
grant select on public.attendance_day_adjustments to authenticated;
drop policy if exists "day adjustments visible to the person or their managers" on public.attendance_day_adjustments;
create policy "day adjustments visible to the person or their managers" on public.attendance_day_adjustments
for select to authenticated using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id = public.current_prosm_time_user_id() or public.prosm_time_caller_sees_person(user_id))
);

-- ------------------------------------------------------------------
-- The policy in force for a person on a day (template > site > organisation > defaults).
-- ------------------------------------------------------------------
create or replace function public.prosm_time_overtime_policy(p_user_id uuid, p_site_id uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    with scopes as (
        select 1 as rank, p.* from overtime_policies p join users u on u.organization_id = p.organization_id
        where u.id = p_user_id and p.site_id is null and p.shift_template_id is null
        union all
        select 2, p.* from overtime_policies p where p.site_id = p_site_id
        union all
        select 3, p.* from overtime_policies p
        where p.shift_template_id in (select sa.shift_template_id from shift_assignments sa where sa.user_id = p_user_id and sa.shift_date = p_day and sa.status = 'scheduled')
    )
    select jsonb_build_object(
        'approvalMode', coalesce((select approval_mode from scopes where approval_mode is not null order by rank desc limit 1), 'approval'),
        'minOvertimeMinutes', coalesce((select min_overtime_minutes from scopes where min_overtime_minutes is not null order by rank desc limit 1), 0),
        'minLateMinutes', coalesce((select min_late_minutes from scopes where min_late_minutes is not null order by rank desc limit 1), 0),
        'maxDailyOvertimeMinutes', (select max_daily_overtime_minutes from scopes where max_daily_overtime_minutes is not null order by rank desc limit 1),
        'multiplierNormal', coalesce((select multiplier_normal from scopes where multiplier_normal is not null order by rank desc limit 1), 1.0),
        'multiplierNight', coalesce((select multiplier_night from scopes where multiplier_night is not null order by rank desc limit 1), 1.0),
        'multiplierWeeklyRest', coalesce((select multiplier_weekly_rest from scopes where multiplier_weekly_rest is not null order by rank desc limit 1), 1.0),
        'multiplierPublicHoliday', coalesce((select multiplier_public_holiday from scopes where multiplier_public_holiday is not null order by rank desc limit 1), 1.0),
        'nightStart', coalesce((select night_start from scopes where night_start is not null order by rank desc limit 1), '22:00'::time),
        'nightEnd', coalesce((select night_end from scopes where night_end is not null order by rank desc limit 1), '06:00'::time)
    );
$function$;

revoke all on function public.prosm_time_overtime_policy(uuid, uuid, date) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- The calculation of one work day. Minutes are exact; nothing is rounded.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_day_summary(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid;
    v_site uuid;
    v_tz text;
    v_first_in timestamptz;
    v_last_out timestamptz;
    v_sessions integer;
    v_worked numeric := 0;
    v_breaks numeric := 0;
    v_unpaid_breaks numeric := 0;
    v_day_type text;
    v_exception jsonb;
    v_policy jsonb;
    v_assignment shift_assignments%rowtype;
    v_template shift_templates%rowtype;
    v_site_row sites%rowtype;
    v_start time;
    v_end time;
    v_overtime_from timestamptz;
    v_raw_overtime numeric := 0;
    v_night_overtime numeric := 0;
    v_overtime numeric := 0;
    v_late numeric := 0;
    v_early numeric := 0;
    v_deduction numeric := 0;
    v_overtime_approved boolean := false;
    v_overtime_pending numeric := 0;
    v_no_overtime boolean := false;
    v_multiplier numeric;
    v_weighted numeric;
    v_adjust attendance_day_adjustments%rowtype;
    v_permission record;
    v_permissions jsonb := '[]'::jsonb;
    v_night_from timestamptz;
    v_night_to timestamptz;
begin
    select organization_id into v_org from users where id = p_user_id;

    select coalesce(ats.site_id, ats.responsible_site_id) into v_site
    from attendance_sessions ats
    where ats.user_id = p_user_id and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
    order by ats.clock_in_at limit 1;
    v_tz := public.prosm_time_site_timezone(v_site, v_org);

    select count(*), min(ats.clock_in_at), max(ats.clock_out_at), coalesce(sum(extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60), 0)
    into v_sessions, v_first_in, v_last_out, v_worked
    from attendance_sessions ats
    where ats.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);

    v_day_type := public.prosm_time_day_type(p_user_id, v_site, p_day);
    v_exception := public.prosm_time_day_exception(p_user_id, v_site, p_day);
    v_policy := public.prosm_time_overtime_policy(p_user_id, v_site, p_day);
    select * into v_assignment from shift_assignments where user_id = p_user_id and shift_date = p_day and status = 'scheduled' order by start_time limit 1;
    if v_assignment.shift_template_id is not null then select * into v_template from shift_templates where id = v_assignment.shift_template_id; end if;
    select * into v_site_row from sites where id = v_site;

    -- d) breaks: unpaid breaks come off the worked time; no break at all on a
    -- template with an automatic deduction takes that deduction.
    select coalesce(sum(extract(epoch from (coalesce(b.ended_at, ats.clock_out_at) - b.started_at)) / 60), 0),
           coalesce(sum(case when not b.paid or v_template.break_paid = false then extract(epoch from (coalesce(b.ended_at, ats.clock_out_at) - b.started_at)) / 60 else 0 end), 0)
    into v_breaks, v_unpaid_breaks
    from break_events b join attendance_sessions ats on ats.id = b.attendance_session_id
    where b.user_id = p_user_id
      and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
      and public.prosm_time_session_counts(ats.status, ats.hours_review_status);
    if v_template.id is not null and v_template.break_max_minutes is not null and v_template.break_paid then
        v_unpaid_breaks := v_unpaid_breaks + greatest(v_breaks - v_template.break_max_minutes, 0);
    end if;
    if v_worked > 0 and v_breaks = 0 and v_template.break_auto_deduct_minutes is not null then
        v_unpaid_breaks := v_unpaid_breaks + v_template.break_auto_deduct_minutes;
    end if;
    v_worked := greatest(v_worked - v_unpaid_breaks, 0);

    -- the day's hours: exceptional day > the person's shift > the site
    v_start := coalesce((v_exception ->> 'start_time')::time,
                        case when v_assignment.id is not null then v_assignment.start_time + make_interval(mins => coalesce(v_site_row.grace_tolerance_minutes, 0)) end,
                        v_site_row.late_deduction_start_time);
    v_end := coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.shift_end_time);

    if v_worked > 0 then
        if v_day_type in ('weekly_rest', 'public_holiday') then
            v_raw_overtime := v_worked;
        else
            v_overtime_from := case
                when coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.overtime_start_time) is null then null
                else (p_day + coalesce((v_exception ->> 'end_time')::time, v_assignment.end_time, v_site_row.overtime_start_time)) at time zone v_tz
                     + case when v_assignment.id is not null and v_assignment.end_time < v_assignment.start_time and (v_exception ->> 'end_time') is null then interval '1 day' else interval '0' end
            end;
            if v_overtime_from is not null then
                select coalesce(sum(greatest(extract(epoch from (ats.clock_out_at - greatest(ats.clock_in_at, v_overtime_from))) / 60, 0)), 0)
                into v_raw_overtime
                from attendance_sessions ats
                where ats.user_id = p_user_id
                  and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
                  and public.prosm_time_session_counts(ats.status, ats.hours_review_status);
                v_raw_overtime := least(v_raw_overtime, v_worked);
            end if;
            if v_start is not null and v_first_in is not null then
                v_late := greatest(extract(epoch from (v_first_in - ((p_day + v_start) at time zone v_tz))) / 60, 0);
            end if;
            if v_end is not null and v_last_out is not null then
                v_early := greatest(extract(epoch from ((((p_day + v_end) at time zone v_tz)
                           + case when v_assignment.id is not null and v_assignment.end_time < v_assignment.start_time and (v_exception ->> 'end_time') is null then interval '1 day' else interval '0' end)
                           - v_last_out)) / 60, 0);
            end if;
        end if;
    end if;

    -- b) thresholds and the daily cap
    if v_raw_overtime < (v_policy ->> 'minOvertimeMinutes')::numeric then v_raw_overtime := 0; end if;
    if v_late <= (v_policy ->> 'minLateMinutes')::numeric then v_late := 0; end if;
    if (v_policy ->> 'maxDailyOvertimeMinutes') is not null then
        v_raw_overtime := least(v_raw_overtime, (v_policy ->> 'maxDailyOvertimeMinutes')::numeric);
    end if;

    -- a) permissions in force
    for v_permission in
        select * from attendance_permissions where user_id = p_user_id and work_date = p_day and status = 'approved' order by created_at
    loop
        v_permissions := v_permissions || jsonb_build_object('id', v_permission.id, 'kind', v_permission.kind, 'paid', v_permission.paid,
                                                             'minutes', v_permission.minutes, 'reason', v_permission.reason);
        if v_permission.kind = 'late_arrival' then
            v_late := case
                when v_permission.paid then 0
                when v_permission.deduction_minutes is not null then least(v_late, v_permission.deduction_minutes)
                else v_late * coalesce(v_permission.deduction_percent, 0) / 100
            end;
        elsif v_permission.kind = 'early_leave' then
            v_early := case
                when v_permission.paid then 0
                when v_permission.deduction_minutes is not null then least(v_early, v_permission.deduction_minutes)
                else v_early * coalesce(v_permission.deduction_percent, 0) / 100
            end;
        elsif v_permission.kind = 'approved_overtime' then
            v_overtime_approved := true;
            if v_permission.minutes is not null then v_raw_overtime := least(v_raw_overtime, v_permission.minutes); end if;
        elsif v_permission.kind = 'no_overtime' then
            v_no_overtime := true;
        end if;
    end loop;

    -- e) the manager's adjustment in force (the latest)
    select * into v_adjust from attendance_day_adjustments where user_id = p_user_id and work_date = p_day order by created_at desc limit 1;
    if v_adjust.id is not null then
        if v_adjust.overtime_approved is not null then v_overtime_approved := v_adjust.overtime_approved; end if;
        if v_adjust.overtime_minutes is not null then v_raw_overtime := v_adjust.overtime_minutes; v_overtime_approved := coalesce(v_adjust.overtime_approved, true); end if;
        if v_adjust.late_minutes is not null then v_late := v_adjust.late_minutes; end if;
    end if;

    if v_no_overtime then
        v_overtime := 0;
    elsif v_policy ->> 'approvalMode' = 'automatic' or v_overtime_approved then
        v_overtime := v_raw_overtime;
    else
        v_overtime := 0;
        v_overtime_pending := v_raw_overtime;
    end if;

    -- c) multipliers: rest day / holiday, otherwise normal with the night part
    if v_overtime > 0 then
        if v_day_type = 'weekly_rest' then
            v_weighted := v_overtime * (v_policy ->> 'multiplierWeeklyRest')::numeric;
        elsif v_day_type = 'public_holiday' then
            v_weighted := v_overtime * (v_policy ->> 'multiplierPublicHoliday')::numeric;
        else
            v_night_from := (p_day + (v_policy ->> 'nightStart')::time) at time zone v_tz;
            v_night_to := ((p_day + case when (v_policy ->> 'nightEnd')::time <= (v_policy ->> 'nightStart')::time then 1 else 0 end) + (v_policy ->> 'nightEnd')::time) at time zone v_tz;
            if v_overtime_from is not null and v_last_out is not null then
                v_night_overtime := least(greatest(extract(epoch from (least(v_last_out, v_night_to) - greatest(v_overtime_from, v_night_from))) / 60, 0), v_overtime);
            end if;
            v_weighted := (v_overtime - v_night_overtime) * (v_policy ->> 'multiplierNormal')::numeric
                        + v_night_overtime * (v_policy ->> 'multiplierNight')::numeric;
        end if;
    else
        v_weighted := 0;
    end if;

    if v_day_type in ('weekly_rest', 'public_holiday') or coalesce((v_exception ->> 'no_deduction')::boolean, false) then
        v_late := 0;
        v_early := 0;
    end if;
    v_deduction := v_late + v_early;
    if v_adjust.id is not null and v_adjust.deduction_minutes is not null then v_deduction := v_adjust.deduction_minutes; end if;

    return jsonb_build_object(
        'day', p_day, 'siteId', v_site, 'dayType', v_day_type, 'sessions', v_sessions,
        'firstIn', v_first_in, 'lastOut', v_last_out,
        'workedMinutes', v_worked, 'breakMinutes', v_breaks, 'unpaidBreakMinutes', v_unpaid_breaks,
        'overtimeMinutes', v_overtime, 'overtimeWeightedMinutes', v_weighted, 'nightOvertimeMinutes', v_night_overtime,
        'overtimePendingApprovalMinutes', v_overtime_pending,
        'lateMinutes', v_late, 'earlyLeaveMinutes', v_early, 'deductionMinutes', v_deduction,
        'noDeduction', coalesce((v_exception ->> 'no_deduction')::boolean, false),
        'permissions', v_permissions, 'adjusted', v_adjust.id is not null,
        'approvalMode', v_policy ->> 'approvalMode'
    );
end;
$function$;

revoke all on function public.prosm_time_day_summary(uuid, date) from public, anon, authenticated;

-- A person's days between two dates, for the timesheet view, reports and
-- exports (only someone who sees the person).
create or replace function public.get_prosm_time_day_summaries(p_user_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_caller_sees_person(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'CHOOSE A PERIOD OF UP TO THREE MONTHS'; end if;
    return coalesce((
        select jsonb_agg(public.prosm_time_day_summary(p_user_id, d::date) order by d)
        from generate_series(p_from, p_to, interval '1 day') d
        where exists (select 1 from attendance_sessions ats where ats.user_id = p_user_id
                        and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = d::date)
           or exists (select 1 from attendance_permissions ap where ap.user_id = p_user_id and ap.work_date = d::date)
    ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_prosm_time_day_summaries(uuid, date, date) from public, anon;
grant execute on function public.get_prosm_time_day_summaries(uuid, date, date) to authenticated;

-- ------------------------------------------------------------------
-- Locks: a day of an approved timesheet or approved allowances is closed.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_require_day_open(p_user_id uuid, p_day date)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if exists (select 1 from timesheets t where t.user_id = p_user_id and t.status in ('approved', 'locked') and p_day between t.period_start and t.period_end)
       or exists (select 1 from allowance_entries e where e.user_id = p_user_id and e.entry_date = p_day and e.status = 'approved') then
        raise exception 'THE TIMESHEET FOR THIS PERIOD IS ALREADY APPROVED';
    end if;
end;
$function$;

revoke all on function public.prosm_time_require_day_open(uuid, date) from public, anon, authenticated;

create or replace function public.prosm_time_require_permission_authority(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') then
        raise exception 'ATTENDANCE.MANAGE_PERMISSIONS AUTHORITY REQUIRED';
    end if;
    if p_user_id = v_caller then raise exception 'YOU CANNOT DECIDE YOUR OWN PERMISSION'; end if;
    if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
end;
$function$;

revoke all on function public.prosm_time_require_permission_authority(uuid) from public, anon, authenticated;

-- After a change that moves a day's minutes: refresh that day's allowances.
create or replace function public.prosm_time_after_day_change(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_entry uuid;
begin
    select id into v_entry from allowance_entries where user_id = p_user_id and entry_date = p_day and status <> 'approved';
    if v_entry is not null then perform public.prosm_time_refresh_allowance_entry(v_entry); end if;
end;
$function$;

revoke all on function public.prosm_time_after_day_change(uuid, date) from public, anon, authenticated;

-- The employee asks in advance (or the same day).
create or replace function public.request_prosm_time_attendance_permission(p_work_date date, p_kind text, p_minutes integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
    v_name text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if public.current_prosm_time_user_is_owner() then raise exception 'THE OWNER DOES NOT CLOCK IN OR OUT'; end if;
    if p_kind not in ('late_arrival', 'early_leave', 'approved_overtime') then raise exception 'INVALID PERMISSION KIND'; end if;
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if p_work_date is null or p_work_date < (now() at time zone public.prosm_time_site_timezone(null, v_org))::date then
        raise exception 'ASK FOR A PERMISSION BEFORE THE DAY - A MANAGER CAN ADD ONE AFTERWARDS';
    end if;
    perform public.prosm_time_require_day_open(v_caller, p_work_date);
    insert into attendance_permissions (organization_id, user_id, work_date, kind, minutes, reason, requested_by)
    values (v_org, v_caller, p_work_date, p_kind, p_minutes, trim(p_reason), v_caller)
    returning id into v_id;
    select full_name into v_name from users where id = v_caller;
    perform public.notify_prosm_time_approvers_of(
        v_caller, 'attendance.manage_permissions', 'exception_pending_review', 'normal', 'Permission waiting for approval',
        v_name || ' asked for a permission on ' || p_work_date || '.', 'attendance_permissions', v_id,
        jsonb_build_object('kind', 'permission', 'permissionKind', p_kind, 'employeeName', v_name, 'workDate', p_work_date, 'reason', trim(p_reason))
    );
    return jsonb_build_object('success', true, 'id', v_id);
end;
$function$;

-- The manager approves or rejects a request (deciding paid / partial deduction).
create or replace function public.review_prosm_time_attendance_permission(
    p_id uuid, p_action text, p_paid boolean default true, p_deduction_percent numeric default null, p_deduction_minutes integer default null, p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_row attendance_permissions%rowtype;
begin
    select * into v_row from attendance_permissions where id = p_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_row.id is null then raise exception 'PERMISSION NOT FOUND'; end if;
    perform public.prosm_time_require_permission_authority(v_row.user_id);
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;
    if v_row.status <> 'pending' then raise exception 'THIS PERMISSION HAS ALREADY BEEN DECIDED'; end if;
    perform public.prosm_time_require_day_open(v_row.user_id, v_row.work_date);
    update attendance_permissions
    set status = p_action, paid = coalesce(p_paid, true), deduction_percent = p_deduction_percent, deduction_minutes = p_deduction_minutes,
        reviewed_by = public.current_prosm_time_user_id(), reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), ''), updated_at = now()
    where id = p_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_row.organization_id, public.current_prosm_time_user_id(), v_row.user_id, 'attendance.permission_' || p_action, 'attendance_permissions', p_id,
            'Attendance permission ' || p_action, coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_row.reason),
            jsonb_build_object('status', 'pending'),
            jsonb_build_object('status', p_action, 'kind', v_row.kind, 'workDate', v_row.work_date, 'paid', coalesce(p_paid, true),
                               'deductionPercent', p_deduction_percent, 'deductionMinutes', p_deduction_minutes));
    perform public.create_prosm_time_notification(
        v_row.organization_id, v_row.user_id, 'correction_reviewed', 'normal', 'Your permission was reviewed',
        'Decision: ' || p_action || '.', 'attendance_permissions', p_id,
        jsonb_build_object('kind', 'permission', 'actionType', p_action) || case when nullif(trim(coalesce(p_notes, '')), '') is not null then jsonb_build_object('notes', trim(p_notes)) else '{}'::jsonb end
    );
    perform public.prosm_time_after_day_change(v_row.user_id, v_row.work_date);
    return jsonb_build_object('success', true);
end;
$function$;

-- The manager grants one directly (in advance or afterwards, before approval of the period).
create or replace function public.grant_prosm_time_attendance_permission(
    p_user_id uuid, p_work_date date, p_kind text, p_minutes integer, p_paid boolean, p_deduction_percent numeric, p_deduction_minutes integer, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_id uuid;
begin
    perform public.prosm_time_require_permission_authority(p_user_id);
    if p_kind not in ('late_arrival', 'early_leave', 'approved_overtime', 'no_overtime') then raise exception 'INVALID PERMISSION KIND'; end if;
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if p_work_date is null then raise exception 'ENTRY DATE IS REQUIRED'; end if;
    perform public.prosm_time_require_day_open(p_user_id, p_work_date);
    insert into attendance_permissions (organization_id, user_id, work_date, kind, minutes, paid, deduction_percent, deduction_minutes, status,
                                        retroactive, reason, requested_by, reviewed_by, reviewed_at)
    values (v_org, p_user_id, p_work_date, p_kind, p_minutes, coalesce(p_paid, true), p_deduction_percent, p_deduction_minutes, 'approved',
            p_work_date < (now() at time zone public.prosm_time_site_timezone(null, v_org))::date, trim(p_reason),
            public.current_prosm_time_user_id(), public.current_prosm_time_user_id(), now())
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, new_state)
    values (v_org, public.current_prosm_time_user_id(), p_user_id, 'attendance.permission_granted', 'attendance_permissions', v_id,
            'Attendance permission granted by a manager', trim(p_reason),
            jsonb_build_object('kind', p_kind, 'workDate', p_work_date, 'minutes', p_minutes, 'paid', coalesce(p_paid, true),
                               'deductionPercent', p_deduction_percent, 'deductionMinutes', p_deduction_minutes));
    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'correction_reviewed', 'normal', 'A permission was added to your day',
        trim(p_reason), 'attendance_permissions', v_id,
        jsonb_build_object('kind', 'permission', 'actionType', 'approved', 'notes', trim(p_reason))
    );
    perform public.prosm_time_after_day_change(p_user_id, p_work_date);
    return jsonb_build_object('success', true, 'id', v_id);
end;
$function$;

-- The employee withdraws a request that is still pending.
create or replace function public.cancel_prosm_time_attendance_permission(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    update attendance_permissions set status = 'cancelled', updated_at = now()
    where id = p_id and user_id = public.current_prosm_time_user_id() and status = 'pending';
    if not found then raise exception 'PERMISSION NOT FOUND'; end if;
    return jsonb_build_object('success', true);
end;
$function$;

-- e) the manager's adjustment of a day (null = leave as calculated).
create or replace function public.adjust_prosm_time_attendance_day(
    p_user_id uuid, p_work_date date, p_overtime_minutes numeric, p_late_minutes numeric, p_deduction_minutes numeric, p_overtime_approved boolean, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_before jsonb;
    v_id uuid;
begin
    perform public.prosm_time_require_permission_authority(p_user_id);
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;
    if p_work_date is null then raise exception 'ENTRY DATE IS REQUIRED'; end if;
    if coalesce(p_overtime_minutes, 0) < 0 or coalesce(p_late_minutes, 0) < 0 or coalesce(p_deduction_minutes, 0) < 0 then raise exception 'MINUTES CANNOT BE NEGATIVE'; end if;
    if p_overtime_minutes is null and p_late_minutes is null and p_deduction_minutes is null and p_overtime_approved is null then raise exception 'NOTHING TO CHANGE'; end if;
    perform public.prosm_time_require_day_open(p_user_id, p_work_date);
    v_before := public.prosm_time_day_summary(p_user_id, p_work_date);
    insert into attendance_day_adjustments (organization_id, user_id, work_date, overtime_minutes, late_minutes, deduction_minutes, overtime_approved, reason, actor_user_id)
    values (public.current_prosm_time_organization_id(), p_user_id, p_work_date, p_overtime_minutes, p_late_minutes, p_deduction_minutes, p_overtime_approved,
            trim(p_reason), public.current_prosm_time_user_id())
    returning id into v_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (public.current_prosm_time_organization_id(), public.current_prosm_time_user_id(), p_user_id,
            case when p_overtime_approved and p_overtime_minutes is null and p_late_minutes is null and p_deduction_minutes is null then 'attendance.overtime_approved' else 'attendance.day_adjusted' end,
            'attendance_day_adjustments', v_id, 'Attendance day adjusted', trim(p_reason),
            jsonb_build_object('overtimeMinutes', v_before -> 'overtimeMinutes', 'pendingOvertime', v_before -> 'overtimePendingApprovalMinutes',
                               'lateMinutes', v_before -> 'lateMinutes', 'deductionMinutes', v_before -> 'deductionMinutes'),
            (select jsonb_build_object('overtimeMinutes', s -> 'overtimeMinutes', 'lateMinutes', s -> 'lateMinutes', 'deductionMinutes', s -> 'deductionMinutes')
             from (select public.prosm_time_day_summary(p_user_id, p_work_date) as s) x));
    perform public.prosm_time_after_day_change(p_user_id, p_work_date);
    return jsonb_build_object('success', true, 'summary', public.prosm_time_day_summary(p_user_id, p_work_date));
end;
$function$;

-- What waits for the manager: pending permission requests, and days whose
-- overtime waits for approval (last 62 days).
create or replace function public.list_prosm_time_permission_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') then
        return jsonb_build_object('requests', '[]'::jsonb, 'overtime', '[]'::jsonb);
    end if;
    return jsonb_build_object(
        'requests', coalesce((
            select jsonb_agg(jsonb_build_object('id', p.id, 'userId', p.user_id, 'employeeName', u.full_name, 'avatarUrl', u.avatar_url,
                                                'workDate', p.work_date, 'kind', p.kind, 'minutes', p.minutes, 'reason', p.reason, 'createdAt', p.created_at)
                             order by p.created_at)
            from attendance_permissions p join users u on u.id = p.user_id
            where p.organization_id = v_org and p.status = 'pending' and p.user_id <> v_caller
              and public.prosm_time_caller_has_authority_over(p.user_id)
        ), '[]'::jsonb),
        'overtime', coalesce((
            select jsonb_agg(x.summary || jsonb_build_object('userId', x.user_id, 'employeeName', x.full_name, 'avatarUrl', x.avatar_url) order by x.day)
            from (
                select d.user_id, d.day, u.full_name, u.avatar_url, public.prosm_time_day_summary(d.user_id, d.day) as summary
                from (
                    select distinct ats.user_id, public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day
                    from attendance_sessions ats
                    where ats.organization_id = v_org and ats.status = 'clocked_out' and ats.clock_in_at > now() - interval '62 days'
                      and ats.user_id <> v_caller
                ) d
                join users u on u.id = d.user_id
                where public.prosm_time_caller_has_authority_over(d.user_id)
                  and not exists (select 1 from allowance_entries e where e.user_id = d.user_id and e.entry_date = d.day and e.status = 'approved')
            ) x
            where (x.summary ->> 'overtimePendingApprovalMinutes')::numeric > 0
        ), '[]'::jsonb)
    );
end;
$function$;

-- b) + c) the policy (the Owner, for the organisation, a site or a shift template).
create or replace function public.set_prosm_time_overtime_policy(p_site_id uuid, p_shift_template_id uuid, p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_before overtime_policies%rowtype;
    v_id uuid;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER SETS THE OVERTIME POLICY'; end if;
    if p_site_id is not null and p_shift_template_id is not null then raise exception 'CHOOSE ONE SCOPE'; end if;
    if p_site_id is not null and not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then raise exception 'SITE NOT FOUND'; end if;
    if p_shift_template_id is not null and not exists (select 1 from shift_templates where id = p_shift_template_id and organization_id = v_org) then raise exception 'SHIFT TEMPLATE NOT FOUND'; end if;
    if (p_policy ->> 'approvalMode') is not null and p_policy ->> 'approvalMode' not in ('automatic', 'approval') then raise exception 'INVALID OVERTIME POLICY'; end if;

    select * into v_before from overtime_policies
    where organization_id = v_org and site_id is not distinct from p_site_id and shift_template_id is not distinct from p_shift_template_id;
    if v_before.id is null then
        insert into overtime_policies (organization_id, site_id, shift_template_id) values (v_org, p_site_id, p_shift_template_id) returning id into v_id;
    else
        v_id := v_before.id;
    end if;
    begin
        update overtime_policies set
            approval_mode = p_policy ->> 'approvalMode',
            min_overtime_minutes = (p_policy ->> 'minOvertimeMinutes')::integer,
            min_late_minutes = (p_policy ->> 'minLateMinutes')::integer,
            max_daily_overtime_minutes = (p_policy ->> 'maxDailyOvertimeMinutes')::integer,
            multiplier_normal = (p_policy ->> 'multiplierNormal')::numeric,
            multiplier_night = (p_policy ->> 'multiplierNight')::numeric,
            multiplier_weekly_rest = (p_policy ->> 'multiplierWeeklyRest')::numeric,
            multiplier_public_holiday = (p_policy ->> 'multiplierPublicHoliday')::numeric,
            night_start = (p_policy ->> 'nightStart')::time,
            night_end = (p_policy ->> 'nightEnd')::time,
            updated_by = public.current_prosm_time_user_id(), updated_at = now()
        where id = v_id;
    exception when check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
        raise exception 'INVALID OVERTIME POLICY';
    end;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state, context)
    values (v_org, public.current_prosm_time_user_id(), 'settings.overtime_policy', 'overtime_policies', v_id, 'Overtime policy changed',
            case when v_before.id is null then null else to_jsonb(v_before) end, p_policy,
            jsonb_build_object('siteId', p_site_id, 'shiftTemplateId', p_shift_template_id));
    return jsonb_build_object('success', true);
end;
$function$;

-- d) break rules of a shift template (schedules.manage at the template's site).
create or replace function public.set_prosm_time_shift_break_rules(p_shift_template_id uuid, p_paid boolean, p_max_minutes integer, p_auto_deduct_minutes integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_template shift_templates%rowtype;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_template from shift_templates where id = p_shift_template_id and organization_id = public.current_prosm_time_organization_id();
    if v_template.id is null then raise exception 'SHIFT TEMPLATE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'schedules.manage')
            and v_template.site_id = any(public.current_prosm_time_managed_site_ids()))
    ) then
        raise exception 'SCHEDULES.MANAGE AUTHORITY REQUIRED FOR THIS SITE';
    end if;
    update shift_templates set break_paid = coalesce(p_paid, true), break_max_minutes = p_max_minutes, break_auto_deduct_minutes = p_auto_deduct_minutes, updated_at = now()
    where id = p_shift_template_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_template.organization_id, public.current_prosm_time_user_id(), 'schedules.break_rules', 'shift_templates', p_shift_template_id, 'Break rules changed',
            jsonb_build_object('paid', v_template.break_paid, 'maxMinutes', v_template.break_max_minutes, 'autoDeductMinutes', v_template.break_auto_deduct_minutes),
            jsonb_build_object('paid', coalesce(p_paid, true), 'maxMinutes', p_max_minutes, 'autoDeductMinutes', p_auto_deduct_minutes));
    return jsonb_build_object('success', true);
exception when check_violation then
    raise exception 'INVALID BREAK RULES';
end;
$function$;

revoke all on function public.request_prosm_time_attendance_permission(date, text, integer, text) from public, anon;
revoke all on function public.review_prosm_time_attendance_permission(uuid, text, boolean, numeric, integer, text) from public, anon;
revoke all on function public.grant_prosm_time_attendance_permission(uuid, date, text, integer, boolean, numeric, integer, text) from public, anon;
revoke all on function public.cancel_prosm_time_attendance_permission(uuid) from public, anon;
revoke all on function public.adjust_prosm_time_attendance_day(uuid, date, numeric, numeric, numeric, boolean, text) from public, anon;
revoke all on function public.list_prosm_time_permission_queue() from public, anon;
revoke all on function public.set_prosm_time_overtime_policy(uuid, uuid, jsonb) from public, anon;
revoke all on function public.set_prosm_time_shift_break_rules(uuid, boolean, integer, integer) from public, anon;
grant execute on function public.request_prosm_time_attendance_permission(date, text, integer, text) to authenticated;
grant execute on function public.review_prosm_time_attendance_permission(uuid, text, boolean, numeric, integer, text) to authenticated;
grant execute on function public.grant_prosm_time_attendance_permission(uuid, date, text, integer, boolean, numeric, integer, text) to authenticated;
grant execute on function public.cancel_prosm_time_attendance_permission(uuid) to authenticated;
grant execute on function public.adjust_prosm_time_attendance_day(uuid, date, numeric, numeric, numeric, boolean, text) to authenticated;
grant execute on function public.list_prosm_time_permission_queue() to authenticated;
grant execute on function public.set_prosm_time_overtime_policy(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_prosm_time_shift_break_rules(uuid, boolean, integer, integer) to authenticated;

-- ------------------------------------------------------------------
-- Allowances read the day's summary: overtime amount = overtime-hour rate x
-- weighted minutes / 60 (multipliers); a rest day / holiday worked is an extra
-- day when priced (as 20261025130000).
-- ------------------------------------------------------------------
create or replace function public.prosm_time_allowance_day_facts(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_session_id uuid;
    v_summary jsonb;
    v_rates jsonb;
    v_overtime numeric;
    v_weighted numeric;
    v_extra_days numeric := 0;
begin
    select ats.id into v_session_id
    from attendance_sessions ats
    where ats.user_id = p_user_id and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) = p_day
    order by ats.clock_in_at desc limit 1;

    v_summary := public.prosm_time_day_summary(p_user_id, p_day);
    v_rates := public.prosm_time_resolve_allowance_rates(p_user_id, (v_summary ->> 'siteId')::uuid);
    v_overtime := (v_summary ->> 'overtimeMinutes')::numeric;
    v_weighted := (v_summary ->> 'overtimeWeightedMinutes')::numeric;

    if v_summary ->> 'dayType' in ('weekly_rest', 'public_holiday') and (v_summary ->> 'workedMinutes')::numeric > 0
       and coalesce((v_rates ->> 'extraDay')::numeric, 0) > 0 then
        v_extra_days := 1;
        v_overtime := 0;
        v_weighted := 0;
    end if;

    return jsonb_build_object(
        'sessionId', v_session_id, 'siteId', v_summary ->> 'siteId', 'workedMinutes', (v_summary ->> 'workedMinutes')::numeric,
        'overtimeMinutes', v_overtime, 'overtimeWeightedMinutes', v_weighted, 'extraDays', v_extra_days,
        'dayType', v_summary ->> 'dayType', 'rates', v_rates
    );
end;
$function$;

create or replace function public.prosm_time_refresh_allowance_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_entry allowance_entries%rowtype;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_key text;
    v_column text;
    v_value numeric;
begin
    select * into v_entry from allowance_entries where id = p_entry_id for update;
    if v_entry.id is null or v_entry.status = 'approved' then return; end if;

    v_facts := public.prosm_time_allowance_day_facts(v_entry.user_id, v_entry.entry_date);
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_entry.organization_id);

    update allowance_entries set
        attendance_session_id = coalesce((v_facts ->> 'sessionId')::uuid, attendance_session_id),
        worked_minutes = (v_facts ->> 'workedMinutes')::numeric,
        overtime_minutes = (v_facts ->> 'overtimeMinutes')::numeric,
        overtime_hours = (v_facts ->> 'overtimeMinutes')::numeric / 60,
        overtime_days = (v_facts ->> 'extraDays')::numeric,
        day_type = v_facts ->> 'dayType',
        overtime_amount = round((v_facts ->> 'overtimeWeightedMinutes')::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0) / 60, 2),
        extra_days_amount = round((v_facts ->> 'extraDays')::numeric * coalesce((v_rates ->> 'extraDay')::numeric, 0), 2),
        updated_at = now()
    where id = p_entry_id;

    foreach v_key in array array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other'] loop
        if v_basis ->> v_key in ('per_hour', 'per_extra_day') then
            v_column := v_key || '_allowance';
            v_value := round(public.prosm_time_allowance_amount(v_basis ->> v_key, (v_rates ->> v_key)::numeric, v_facts), 2);
            execute format('update allowance_entries set %I = $1 where id = $2', v_column) using v_value, p_entry_id;
        end if;
    end loop;

    for v_key in select jsonb_object_keys(v_entry.manual_overrides) loop
        v_column := public.prosm_time_allowance_line_column(v_key);
        if v_column is not null then
            execute format('update allowance_entries set %I = $1 where id = $2', v_column)
            using (v_entry.manual_overrides -> v_key ->> 'value')::numeric, p_entry_id;
        end if;
    end loop;
end;
$function$;

-- ------------------------------------------------------------------
-- Timesheets add up the days' summaries (same numbers as allowances).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
    v_deduction_minutes double precision := 0;
    v_leave_days numeric := 0;
    v_exceptions_count integer := 0;
    v_corrections_count integer := 0;
    v_timesheet_id uuid;
    v_existing_status text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_period_end < p_period_start then raise exception 'PERIOD END MUST NOT BE BEFORE PERIOD START'; end if;

    select organization_id into v_org_id from users where id = p_user_id;
    if v_org_id is null then raise exception 'EMPLOYEE NOT FOUND'; end if;

    if not (
        v_org_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner() or p_user_id = v_caller_id
            or (
                'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over(p_user_id)
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE';
    end if;

    select id, status into v_timesheet_id, v_existing_status
    from timesheets where user_id = p_user_id and period_start = p_period_start and period_end = p_period_end;

    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    -- A shift whose out-of-area exception was rejected still ends at the
    -- violation (rejected_exception_cap of the earlier versions): the cap is
    -- applied to the worked time here.
    with days as (
        select distinct public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day
        from attendance_sessions ats
        where ats.user_id = p_user_id
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_period_start and p_period_end
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
    ),
    summaries as (select public.prosm_time_day_summary(p_user_id, d.day) as s from days d)
    select coalesce(sum((s ->> 'workedMinutes')::numeric), 0),
           coalesce(sum((s ->> 'breakMinutes')::numeric), 0),
           coalesce(sum((s ->> 'overtimeMinutes')::numeric), 0),
           coalesce(sum((s ->> 'deductionMinutes')::numeric), 0)
    into v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes
    from summaries;

    v_worked_minutes := v_worked_minutes - coalesce((
        select sum(extract(epoch from (ats.clock_out_at - least(ats.clock_out_at, cap.cap_at))) / 60)
        from attendance_sessions ats
        join (
            select coalesce(ae.session_id, ps.attendance_session_id) as session_id, min(ge.created_at) as cap_at
            from geofence_exceptions ge
            left join attendance_events ae on ae.id = ge.attendance_event_id
            left join presence_sessions ps on ps.id = ge.presence_session_id
            where ge.user_id = p_user_id
              and exists (
                  select 1 from exception_actions ea
                  where ea.geofence_exception_id = ge.id and ea.action_type = 'rejected'
                    and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
              )
            group by coalesce(ae.session_id, ps.attendance_session_id)
        ) cap on cap.session_id = ats.id
        where ats.user_id = p_user_id
          and public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) between p_period_start and p_period_end
          and public.prosm_time_session_counts(ats.status, ats.hours_review_status)
    ), 0);
    v_overtime_minutes := least(v_overtime_minutes, greatest(v_worked_minutes, 0));

    select coalesce(sum(
        least(lr.end_date, p_period_end) - greatest(lr.start_date, p_period_start) + 1
    ), 0)
    into v_leave_days
    from leave_requests lr
    where lr.user_id = p_user_id
      and lr.status = 'approved'
      and lr.start_date <= p_period_end
      and lr.end_date >= p_period_start;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes, total_deduction_minutes, total_leave_days,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes, v_deduction_minutes, v_leave_days,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        total_deduction_minutes = excluded.total_deduction_minutes,
        total_leave_days = excluded.total_leave_days,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    if p_user_id <> v_caller_id then
        perform public.create_prosm_time_notification(
            v_org_id, p_user_id, 'timesheet_ready', 'normal', 'Your timesheet is ready',
            'Review your timesheet for ' || p_period_start || ' - ' || p_period_end || ' and submit it.',
            'timesheets', v_timesheet_id,
            jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end)
        );
    end if;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

-- The dashboard counts permission requests waiting too.
do $$
declare
    v_def text;
    v_anchor constant text := 'union all select user_id from attendance_sessions where organization_id = v_org and hours_review_status = ''pending''';
begin
    v_def := pg_get_functiondef('public.get_prosm_time_dashboard_summary(date, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then
        raise exception 'get_prosm_time_dashboard_summary changed - pending sessions line not found';
    end if;
    execute replace(v_def, v_anchor, v_anchor || chr(10) || '        union all select user_id from attendance_permissions where organization_id = v_org and status = ''pending''');
end;
$$;

-- Recalculate the time-based parts of every entry not yet approved.
do $$
declare
    v_id uuid;
begin
    for v_id in select id from public.allowance_entries where status <> 'approved' loop
        perform public.prosm_time_refresh_allowance_entry(v_id);
    end loop;
end $$;

commit;
