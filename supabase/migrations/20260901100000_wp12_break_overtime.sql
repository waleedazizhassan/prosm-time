-- WP-12 (§17.1 Break/Lunch Lifecycle, §17.2 Overtime Policy Engine).
-- "Timesheet integration" means this pass builds the real engine
-- WP-16 (Timesheets, its own later row) will call/persist against -
-- no timesheet UI/storage here, matching how WP-09 built the geofence
-- engine WP-11 later consumed.

-- Break policy (§17.1: "paid vs unpaid, max duration, whether GPS/
-- camera required") - same per-site-toggle pattern as every other
-- site policy (WP-05 onward).
alter table public.sites
    add column break_paid_by_default boolean not null default true,
    add column break_max_duration_minutes integer not null default 30,
    add column break_gps_required boolean not null default false,
    add column break_camera_required boolean not null default false,
    add column daily_overtime_threshold_minutes integer,
    add column weekly_overtime_threshold_minutes integer;

-- Overtime org-level defaults (§17.2: "Organization- and site-level
-- rules") - sites.* above are nullable overrides, null = inherit these.
alter table public.organization_settings
    add column daily_overtime_threshold_minutes integer not null default 480,
    add column weekly_overtime_threshold_minutes integer not null default 2400,
    add column overtime_requires_preapproval boolean not null default false;

create table public.break_events (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    attendance_session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    status text not null default 'active' check (status in ('active', 'ended')),
    paid boolean not null,
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    max_duration_exceeded boolean not null default false,
    idempotency_key text,
    created_at timestamptz not null default now(),
    unique (user_id, idempotency_key)
);

create index break_events_organization_id_idx on public.break_events(organization_id);
create index break_events_attendance_session_id_idx on public.break_events(attendance_session_id);

create unique index break_events_one_active_per_session
    on public.break_events (attendance_session_id)
    where status = 'active';

alter table public.break_events enable row level security;
revoke all on public.break_events from anon, authenticated;
grant select on public.break_events to authenticated;

create policy "break events visible to subject or attendance.view"
on public.break_events for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (organization_id = public.current_prosm_time_organization_id() and (public.current_prosm_time_user_is_owner() or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))))
);

-- Self-service: caller must own the (still clocked-in) session, no
-- other active break on it. §17.1: "not a hard block" - max duration
-- is recorded on end, never rejected.
create or replace function public.start_prosm_time_break(
    p_attendance_session_id uuid,
    p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_session attendance_sessions%rowtype;
    v_site sites%rowtype;
    v_break_id uuid;
    v_existing break_events%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_idempotency_key is not null then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id and user_id = v_caller_id;
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.status <> 'clocked_in' then raise exception 'YOU MUST BE CLOCKED IN TO START A BREAK'; end if;

    select * into v_site from sites where id = v_session.site_id;

    insert into break_events (organization_id, attendance_session_id, user_id, paid, idempotency_key)
    values (v_session.organization_id, p_attendance_session_id, v_caller_id, v_site.break_paid_by_default, p_idempotency_key)
    returning id into v_break_id;

    return jsonb_build_object('success', true, 'breakId', v_break_id, 'replay', false);
exception
    when unique_violation then
        select * into v_existing from break_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
            return jsonb_build_object('success', true, 'breakId', v_existing.id, 'replay', true);
        end if;
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
    when others then
        raise exception 'START PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.end_prosm_time_break(p_break_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_break break_events%rowtype;
    v_site sites%rowtype;
    v_exceeded boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_break from break_events where id = p_break_id and user_id = v_caller_id;
    if v_break.id is null then raise exception 'BREAK NOT FOUND'; end if;
    if v_break.status <> 'active' then raise exception 'THIS BREAK IS ALREADY ENDED'; end if;

    select s.* into v_site from attendance_sessions ats join sites s on s.id = ats.site_id where ats.id = v_break.attendance_session_id;

    v_exceeded := extract(epoch from (now() - v_break.started_at)) / 60 > v_site.break_max_duration_minutes;

    update break_events set status = 'ended', ended_at = now(), max_duration_exceeded = v_exceeded where id = p_break_id;

    return jsonb_build_object('success', true, 'maxDurationExceeded', v_exceeded);
exception
    when others then
        raise exception 'END PROSM TIME BREAK FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.start_prosm_time_break(uuid, text) to authenticated;
grant execute on function public.end_prosm_time_break(uuid) to authenticated;

-- §17.2: "Computed server-side from approved attendance events, never
-- self-reported." Real engine - sums closed attendance sessions for
-- the given UTC date, subtracts unpaid break minutes, splits against
-- the site's own override or the organization's default threshold.
-- "Approved" here means computed purely from the authoritative
-- attendance_sessions/break_events tables themselves (server-written,
-- never client-editable) - not gated on any exception/correction
-- review status, which is a real, separate refinement WP-16 can layer
-- on when it actually builds timesheet approval.
create or replace function public.compute_prosm_time_daily_overtime(
    p_user_id uuid,
    p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_unpaid_break_minutes double precision := 0;
    v_threshold_minutes integer;
    v_regular_minutes double precision;
    v_overtime_minutes double precision;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select organization_id into v_org_id from users where id = p_user_id;
    if v_org_id is null then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    if not (
        p_user_id = v_caller_id
        or (
            v_org_id = public.current_prosm_time_organization_id()
            and (
                public.current_prosm_time_user_is_owner()
                or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS EMPLOYEE''S OVERTIME';
    end if;

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    select coalesce(sum(extract(epoch from (coalesce(clock_out_at, now()) - clock_in_at)) / 60), 0)
    into v_worked_minutes
    from attendance_sessions
    where user_id = p_user_id and clock_in_at::date = p_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_unpaid_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date = p_date and be.paid = false;

    select s.daily_overtime_threshold_minutes into v_threshold_minutes
    from attendance_sessions ats join sites s on s.id = ats.site_id
    where ats.user_id = p_user_id and ats.clock_in_at::date = p_date
    order by ats.clock_in_at desc limit 1;

    v_threshold_minutes := coalesce(v_threshold_minutes, v_org_threshold, 480);

    v_worked_minutes := greatest(v_worked_minutes - v_unpaid_break_minutes, 0);
    v_regular_minutes := least(v_worked_minutes, v_threshold_minutes);
    v_overtime_minutes := greatest(v_worked_minutes - v_threshold_minutes, 0);

    return jsonb_build_object(
        'workedMinutes', v_worked_minutes,
        'unpaidBreakMinutes', v_unpaid_break_minutes,
        'thresholdMinutes', v_threshold_minutes,
        'regularMinutes', v_regular_minutes,
        'overtimeMinutes', v_overtime_minutes
    );
exception
    when others then
        raise exception 'COMPUTE PROSM TIME DAILY OVERTIME FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.compute_prosm_time_daily_overtime(uuid, date) from public, anon;
grant execute on function public.compute_prosm_time_daily_overtime(uuid, date) to authenticated;
