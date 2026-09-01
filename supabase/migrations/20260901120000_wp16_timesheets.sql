-- PROSM Time Implementation Master File V3.0, WP-16 (Timesheets |
-- §22 "Timesheet & Monthly Evidence Pack"). Row: "Period calculation,
-- review, approval, locking and correction." PDF/spreadsheet export
-- and the Monthly Evidence Pack itself are WP-17's own later row -
-- this migration builds the real record/workflow they will export,
-- not a placeholder.
--
-- §22: "Employee reviews their period; manager reviews and approves;
-- approved period becomes locked. Correction requires an explicit
-- correction workflow and audit trail." Modeled as three tables
-- (§34): `timesheets` (the aggregate record + its own status/lock
-- state), `timesheet_approvals` (append-only audit of every
-- submit/approve/reject/reopen transition), `timesheet_corrections`
-- (the explicit post-lock correction workflow, distinct from WP-11's
-- attendance-event-level correction_requests). Line items (which
-- site/project/day/Clock In/Out this period covers) are deliberately
-- NOT duplicated into the timesheet row - they are read live from the
-- already-authoritative attendance_sessions/break_events via
-- list_prosm_time_timesheet_entries() below, single source of truth.

begin;

create table public.timesheets (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    period_start date not null,
    period_end date not null,
    status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
    total_worked_minutes double precision not null default 0,
    total_break_minutes double precision not null default 0,
    total_overtime_minutes double precision not null default 0,
    exceptions_count integer not null default 0,
    corrections_count integer not null default 0,
    generated_by uuid references public.users(id) on delete set null,
    generated_at timestamptz not null default now(),
    submitted_at timestamptz,
    approved_by uuid references public.users(id) on delete set null,
    approved_at timestamptz,
    locked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (period_end >= period_start),
    unique (user_id, period_start, period_end)
);

create index timesheets_organization_id_idx on public.timesheets(organization_id);
create index timesheets_user_id_idx on public.timesheets(user_id);

-- §22: "Correction requires an explicit correction workflow and audit
-- trail" - one append-only row per state transition, mirrors WP-11's
-- exception_actions pattern.
create table public.timesheet_approvals (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    timesheet_id uuid not null references public.timesheets(id) on delete cascade,
    actor_user_id uuid not null references public.users(id) on delete restrict,
    action text not null check (action in ('submitted', 'approved', 'rejected', 'reopened')),
    notes text,
    created_at timestamptz not null default now()
);

create index timesheet_approvals_timesheet_id_idx on public.timesheet_approvals(timesheet_id);

create table public.timesheet_corrections (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    timesheet_id uuid not null references public.timesheets(id) on delete cascade,
    requested_by uuid not null references public.users(id) on delete restrict,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now()
);

create index timesheet_corrections_timesheet_id_idx on public.timesheet_corrections(timesheet_id);

-- WP-13's notifications.type check constraint only named its own
-- seven event types - extend it (never edit the already-shipped
-- WP-13 migration file itself) to admit the timesheet lifecycle
-- events this WP fires.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review',
    'correction_submitted', 'correction_reviewed', 'break_exceeded', 'sos_alert',
    'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected'
));

alter table public.timesheets enable row level security;
alter table public.timesheet_approvals enable row level security;
alter table public.timesheet_corrections enable row level security;

revoke all on public.timesheets from anon, authenticated;
revoke all on public.timesheet_approvals from anon, authenticated;
revoke all on public.timesheet_corrections from anon, authenticated;
grant select on public.timesheets to authenticated;
grant select on public.timesheet_approvals to authenticated;
grant select on public.timesheet_corrections to authenticated;

create policy "timesheets visible to subject or timesheet permission holders"
on public.timesheets for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

create policy "timesheet approvals visible to subject or timesheet permission holders"
on public.timesheet_approvals for select to authenticated
using (
    exists (
        select 1 from timesheets t where t.id = timesheet_approvals.timesheet_id
        and (
            t.user_id = public.current_prosm_time_user_id()
            or (
                t.organization_id = public.current_prosm_time_organization_id()
                and (
                    public.current_prosm_time_user_is_owner()
                    or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                    or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                )
            )
        )
    )
);

create policy "timesheet corrections visible to subject or timesheet permission holders"
on public.timesheet_corrections for select to authenticated
using (
    requested_by = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.correct' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- ============================================================
-- Internal permission lookup, no caller-authorization gate. §
-- Lesson learned in WP-13: get_prosm_time_effective_permissions()
-- enforces "caller must be self or hold administrators.manage/
-- permissions.assign to inspect someone else's permissions", which is
-- correct for its real client-facing callers but wrong for an
-- internal SECURITY DEFINER lookup checking a THIRD PARTY's
-- permissions on the system's own behalf (e.g. "who can I notify?").
-- This inlines the same role-bundle-XOR-override computation without
-- that gate, for internal use only - never exposed to PostgREST.
-- ============================================================
create or replace function public.prosm_time_user_has_permission_internal(p_user_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select
        exists (select 1 from users where id = p_user_id and is_owner = true)
        or p_permission_key = any(coalesce((
            select array_agg(distinct permission_key) from (
                select p.permission_key
                from role_default_permissions rdp
                join permissions p on p.id = rdp.permission_id
                join users u on u.role_id = rdp.role_id
                where u.id = p_user_id
                union
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = true
                except
                select p.permission_key
                from user_permission_overrides upo
                join permissions p on p.id = upo.permission_id
                where upo.user_id = p_user_id and upo.is_granted = false
            ) effective
        ), array[]::text[]));
$function$;

create or replace function public.notify_prosm_time_timesheet_approvers(
    p_organization_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_approver record;
begin
    for v_approver in select id from users where organization_id = p_organization_id loop
        if public.prosm_time_user_has_permission_internal(v_approver.id, 'timesheets.approve') then
            perform public.create_prosm_time_notification(p_organization_id, v_approver.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id);
        end if;
    end loop;
end;
$function$;

-- ============================================================
-- Period calculation. §17.2's daily overtime formula (WP-12), summed
-- per calendar day across the period rather than reusing
-- compute_prosm_time_daily_overtime() as a nested call - that
-- function re-checks "self or attendance.view" against the CALLER,
-- which would wrongly reject a manager who holds timesheets.generate
-- but not attendance.view generating someone else's timesheet (the
-- exact class of bug fixed in WP-13). This RPC does its own single
-- up-front authorization check instead.
-- ============================================================
create or replace function public.generate_prosm_time_timesheet(
    p_user_id uuid,
    p_period_start date,
    p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
    v_worked_minutes double precision := 0;
    v_break_minutes double precision := 0;
    v_overtime_minutes double precision := 0;
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
            public.current_prosm_time_user_is_owner()
            or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE';
    end if;

    select id, status into v_timesheet_id, v_existing_status
    from timesheets where user_id = p_user_id and period_start = p_period_start and period_end = p_period_end;

    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    with daily as (
        select
            ats.clock_in_at::date as work_date,
            sum(extract(epoch from (coalesce(ats.clock_out_at, now()) - ats.clock_in_at)) / 60) as worked_minutes,
            coalesce((
                select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60)
                from break_events be
                join attendance_sessions ats2 on ats2.id = be.attendance_session_id
                where be.user_id = p_user_id and ats2.clock_in_at::date = ats.clock_in_at::date and be.paid = false
            ), 0) as unpaid_break_minutes,
            (
                select s.daily_overtime_threshold_minutes
                from attendance_sessions a2 join sites s on s.id = a2.site_id
                where a2.user_id = p_user_id and a2.clock_in_at::date = ats.clock_in_at::date
                order by a2.clock_in_at desc limit 1
            ) as site_threshold
        from attendance_sessions ats
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
        group by ats.clock_in_at::date
    )
    select
        coalesce(sum(worked_minutes), 0),
        coalesce(sum(greatest(worked_minutes - unpaid_break_minutes - coalesce(site_threshold, v_org_threshold, 480), 0)), 0)
    into v_worked_minutes, v_overtime_minutes
    from daily;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end;

    select count(*) into v_exceptions_count from geofence_exceptions where user_id = p_user_id and created_at::date between p_period_start and p_period_end;
    select count(*) into v_corrections_count from correction_requests where user_id = p_user_id and created_at::date between p_period_start and p_period_end;

    insert into timesheets (
        organization_id, user_id, period_start, period_end, status,
        total_worked_minutes, total_break_minutes, total_overtime_minutes,
        exceptions_count, corrections_count, generated_by, generated_at, updated_at
    ) values (
        v_org_id, p_user_id, p_period_start, p_period_end, 'draft',
        v_worked_minutes, v_break_minutes, v_overtime_minutes,
        v_exceptions_count, v_corrections_count, v_caller_id, now(), now()
    )
    on conflict (user_id, period_start, period_end) do update set
        total_worked_minutes = excluded.total_worked_minutes,
        total_break_minutes = excluded.total_break_minutes,
        total_overtime_minutes = excluded.total_overtime_minutes,
        exceptions_count = excluded.exceptions_count,
        corrections_count = excluded.corrections_count,
        generated_by = excluded.generated_by,
        generated_at = excluded.generated_at,
        updated_at = now()
    returning id into v_timesheet_id;

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.submit_prosm_time_timesheet(p_timesheet_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;
    if v_timesheet.user_id <> v_caller_id then raise exception 'YOU MAY ONLY SUBMIT YOUR OWN TIMESHEET'; end if;
    if v_timesheet.status <> 'draft' then raise exception 'THIS TIMESHEET IS NOT IN DRAFT STATUS'; end if;

    update timesheets set status = 'submitted', submitted_at = now(), updated_at = now() where id = p_timesheet_id;

    insert into timesheet_approvals (organization_id, timesheet_id, actor_user_id, action)
    values (v_timesheet.organization_id, p_timesheet_id, v_caller_id, 'submitted');

    perform public.notify_prosm_time_timesheet_approvers(
        v_timesheet.organization_id, 'timesheet_submitted', 'normal',
        'Timesheet submitted for review',
        'A timesheet was submitted and is awaiting your approval.',
        'timesheet', p_timesheet_id
    );

    return jsonb_build_object('success', true, 'timesheetId', p_timesheet_id);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.approve_prosm_time_timesheet(
    p_timesheet_id uuid,
    p_action text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    if not (
        v_timesheet.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO APPROVE THIS TIMESHEET';
    end if;

    if v_timesheet.status <> 'submitted' then raise exception 'THIS TIMESHEET IS NOT AWAITING APPROVAL'; end if;

    if p_action = 'approved' then
        update timesheets set status = 'approved', approved_by = v_caller_id, approved_at = now(), locked_at = now(), updated_at = now() where id = p_timesheet_id;
    else
        update timesheets set status = 'draft', submitted_at = null, updated_at = now() where id = p_timesheet_id;
    end if;

    insert into timesheet_approvals (organization_id, timesheet_id, actor_user_id, action, notes)
    values (v_timesheet.organization_id, p_timesheet_id, v_caller_id, p_action, p_notes);

    perform public.create_prosm_time_notification(
        v_timesheet.organization_id, v_timesheet.user_id,
        case when p_action = 'approved' then 'timesheet_approved' else 'timesheet_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Timesheet approved' else 'Timesheet rejected' end,
        coalesce(p_notes, case when p_action = 'approved' then 'Your timesheet was approved and is now locked.' else 'Your timesheet was rejected and returned to draft.' end),
        'timesheet', p_timesheet_id
    );

    return jsonb_build_object('success', true, 'timesheetId', p_timesheet_id, 'status', p_action);
exception
    when others then
        raise exception 'APPROVE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.request_prosm_time_timesheet_correction(
    p_timesheet_id uuid,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
    v_correction_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A REASON IS REQUIRED'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;
    if v_timesheet.user_id <> v_caller_id then raise exception 'YOU MAY ONLY REQUEST A CORRECTION ON YOUR OWN TIMESHEET'; end if;
    if v_timesheet.status <> 'approved' then raise exception 'A CORRECTION CAN ONLY BE REQUESTED ON A LOCKED (APPROVED) TIMESHEET'; end if;

    insert into timesheet_corrections (organization_id, timesheet_id, requested_by, reason)
    values (v_timesheet.organization_id, p_timesheet_id, v_caller_id, p_reason)
    returning id into v_correction_id;

    perform public.notify_prosm_time_timesheet_approvers(
        v_timesheet.organization_id, 'timesheet_correction_requested', 'normal',
        'Timesheet correction requested',
        'An employee requested a correction on a locked timesheet.',
        'timesheet_correction', v_correction_id
    );

    return jsonb_build_object('success', true, 'correctionId', v_correction_id);
exception
    when others then
        raise exception 'REQUEST PROSM TIME TIMESHEET CORRECTION FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.review_prosm_time_timesheet_correction(
    p_correction_id uuid,
    p_action text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_correction timesheet_corrections%rowtype;
    v_timesheet timesheets%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;

    select * into v_correction from timesheet_corrections where id = p_correction_id;
    if v_correction.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;
    if v_correction.status <> 'pending' then raise exception 'THIS CORRECTION REQUEST HAS ALREADY BEEN REVIEWED'; end if;

    if not (
        v_correction.organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.correct' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW THIS CORRECTION REQUEST';
    end if;

    select * into v_timesheet from timesheets where id = v_correction.timesheet_id;

    update timesheet_corrections set status = p_action, reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes where id = p_correction_id;

    if p_action = 'approved' then
        update timesheets set status = 'draft', approved_by = null, approved_at = null, locked_at = null, submitted_at = null, updated_at = now() where id = v_correction.timesheet_id;

        insert into timesheet_approvals (organization_id, timesheet_id, actor_user_id, action, notes)
        values (v_timesheet.organization_id, v_correction.timesheet_id, v_caller_id, 'reopened', p_notes);
    end if;

    perform public.create_prosm_time_notification(
        v_timesheet.organization_id, v_timesheet.user_id,
        case when p_action = 'approved' then 'timesheet_correction_approved' else 'timesheet_correction_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Timesheet correction approved' else 'Timesheet correction rejected' end,
        coalesce(p_notes, case when p_action = 'approved' then 'Your timesheet correction was approved and the period reopened for resubmission.' else 'Your timesheet correction request was rejected.' end),
        'timesheet_correction', p_correction_id
    );

    return jsonb_build_object('success', true, 'correctionId', p_correction_id, 'status', p_action);
exception
    when others then
        raise exception 'REVIEW PROSM TIME TIMESHEET CORRECTION FAILED: %', sqlerrm;
end;
$function$;

-- Read-only line items for a timesheet's own period - self-contained
-- authorization (same bar as the timesheets SELECT policy) so a
-- caller holding only timesheets.approve/timesheets.generate (and not
-- attendance.view) can still see what they are being asked to
-- approve, rather than depending on attendance_sessions' own RLS.
create or replace function public.list_prosm_time_timesheet_entries(p_timesheet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
    v_entries jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    if not (
        v_timesheet.user_id = v_caller_id
        or (
            v_timesheet.organization_id = public.current_prosm_time_organization_id()
            and (
                public.current_prosm_time_user_is_owner()
                or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS TIMESHEET';
    end if;

    select coalesce(jsonb_agg(entry order by entry->>'clockInAt'), '[]'::jsonb) into v_entries
    from (
        select jsonb_build_object(
            'sessionId', ats.id,
            'siteId', ats.site_id,
            'siteName', s.name,
            'projectId', ats.project_id,
            'projectName', p.name,
            'clockInAt', ats.clock_in_at,
            'clockOutAt', ats.clock_out_at,
            'workedMinutes', extract(epoch from (coalesce(ats.clock_out_at, now()) - ats.clock_in_at)) / 60,
            'breakMinutes', coalesce((
                select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60)
                from break_events be where be.attendance_session_id = ats.id
            ), 0)
        ) as entry
        from attendance_sessions ats
        left join sites s on s.id = ats.site_id
        left join projects p on p.id = ats.project_id
        where ats.user_id = v_timesheet.user_id
        and ats.clock_in_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    return jsonb_build_object('success', true, 'entries', v_entries);
exception
    when others then
        raise exception 'LIST PROSM TIME TIMESHEET ENTRIES FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.generate_prosm_time_timesheet(uuid, date, date) to authenticated;
grant execute on function public.submit_prosm_time_timesheet(uuid) to authenticated;
grant execute on function public.approve_prosm_time_timesheet(uuid, text, text) to authenticated;
grant execute on function public.request_prosm_time_timesheet_correction(uuid, text) to authenticated;
grant execute on function public.review_prosm_time_timesheet_correction(uuid, text, text) to authenticated;
grant execute on function public.list_prosm_time_timesheet_entries(uuid) to authenticated;

commit;
