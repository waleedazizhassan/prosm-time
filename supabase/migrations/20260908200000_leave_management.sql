-- PROSM Time - real PTO/leave management, a genuine gap versus every
-- competitor researched this session (Jibble, Deputy, Connecteam,
-- ClockShark, Homebase - all have request/approve leave with balance
-- tracking; PROSM Time had none). A real governed lifecycle, matching
-- this session's own established standard for a new domain (request ->
-- supervisor review -> notification, same shape as geofence exceptions/
-- correction requests) - not a bare log.
--
-- Balance tracking is deliberately scoped to 'annual' leave only -
-- real HR systems universally cap annual/vacation leave against an
-- entitlement, but treat sick/unpaid/emergency/other as approval-gated
-- without a hard balance (sick leave especially - capping it against a
-- "balance" is not how it actually works almost anywhere). Other types
-- still show a "days taken this year" figure for visibility, just
-- never a remaining/entitled balance.
--
-- days_count is calendar-day-inclusive (end_date - start_date + 1),
-- weekends included - a real simplification (excluding weekends/
-- holidays needs a per-org work-week calendar this schema does not
-- have), documented here rather than silently assumed.

begin;

alter table public.organization_settings
    add column if not exists default_annual_leave_days numeric not null default 21;

create table public.leave_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    leave_type text not null check (leave_type in ('annual', 'sick', 'unpaid', 'emergency', 'other')),
    start_date date not null,
    end_date date not null,
    days_count numeric not null,
    reason text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint leave_requests_valid_range check (end_date >= start_date)
);

create index leave_requests_organization_id_idx on public.leave_requests(organization_id);
create index leave_requests_user_id_idx on public.leave_requests(user_id);
create index leave_requests_status_idx on public.leave_requests(status);

create table public.leave_entitlements (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    leave_type text not null check (leave_type in ('annual', 'sick', 'unpaid', 'emergency', 'other')),
    year integer not null,
    entitled_days numeric not null default 0,
    set_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, leave_type, year)
);

create index leave_entitlements_organization_id_idx on public.leave_entitlements(organization_id);

alter table public.leave_requests enable row level security;
alter table public.leave_entitlements enable row level security;

revoke all on public.leave_requests from anon, authenticated;
revoke all on public.leave_entitlements from anon, authenticated;
grant select on public.leave_requests to authenticated;
grant select on public.leave_entitlements to authenticated;

-- Same tier as attendance.view (org-wide) / self (own rows only) used
-- throughout this schema - exceptions.manage is the established
-- "supervisor" permission this session already reuses for reviewing
-- geofence exceptions and correction requests.
create policy "members can view own leave requests"
on public.leave_requests for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'exceptions.manage')
);

create policy "members can view own leave entitlements"
on public.leave_entitlements for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'exceptions.manage')
);

-- ============================================================
-- request_prosm_time_leave
-- ============================================================
create or replace function public.request_prosm_time_leave(
    p_leave_type text,
    p_start_date date,
    p_end_date date,
    p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_caller_name text;
    v_days numeric;
    v_request_id uuid;
    v_has_overlap boolean;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if p_leave_type not in ('annual', 'sick', 'unpaid', 'emergency', 'other') then
        raise exception 'INVALID LEAVE TYPE';
    end if;
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;
    if p_end_date < p_start_date then
        raise exception 'END DATE MUST NOT BE BEFORE START DATE';
    end if;

    select exists (
        select 1 from leave_requests
        where user_id = v_caller_id
          and status in ('pending', 'approved')
          and p_start_date <= end_date and p_end_date >= start_date
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'YOU ALREADY HAVE A PENDING OR APPROVED LEAVE REQUEST OVERLAPPING THESE DATES';
    end if;

    v_org := public.current_prosm_time_organization_id();
    v_days := (p_end_date - p_start_date) + 1;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.notify_prosm_time_supervisors(
        v_org, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
        v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
        'leave_requests', v_request_id,
        jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
    );

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- cancel_prosm_time_leave_request - the requester's own PENDING
-- request only ("changed my mind before anyone reviewed it"). Revoking
-- an already-APPROVED leave is a supervisor decision instead
-- (review_prosm_time_leave below reuses 'reject' for that case too -
-- see its own header comment).
-- ============================================================
create or replace function public.cancel_prosm_time_leave_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_status text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select status into v_status from leave_requests where id = p_request_id and user_id = v_caller_id;
    if v_status is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if v_status <> 'pending' then
        raise exception 'ONLY A PENDING LEAVE REQUEST CAN BE CANCELLED THIS WAY - ASK YOUR MANAGER TO REVOKE AN APPROVED ONE';
    end if;

    update leave_requests set status = 'cancelled', updated_at = now() where id = p_request_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CANCEL PROSM TIME LEAVE REQUEST FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- review_prosm_time_leave - a supervisor's decision. Works on a
-- PENDING request (approve/reject) and, deliberately, also on an
-- already-APPROVED one via 'reject' (revoking previously-approved
-- leave - plans change) - the one governed path for that, matching
-- this session's own "deactivate/revoke instead of silently deleting"
-- posture elsewhere in this same codebase.
-- ============================================================
create or replace function public.review_prosm_time_leave(
    p_request_id uuid,
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
    v_org uuid;
    v_request leave_requests%rowtype;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;
    if p_action not in ('approve', 'reject') then
        raise exception 'INVALID ACTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    if v_request.status = 'approved' and p_action = 'approve' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    update leave_requests
    set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
        reviewed_by = v_caller_id, reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), ''),
        updated_at = now()
    where id = p_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.create_prosm_time_notification(
        v_org, v_request.user_id, 'correction_reviewed', 'normal', 'Your leave request was reviewed',
        'Decision: ' || p_action || '.', 'leave_requests', p_request_id,
        jsonb_build_object('kind', 'leave', 'actionType', p_action)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REVIEW PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- get_prosm_time_leave_balance - the caller's own balance, or a
-- specified employee's (supervisor authority required for anyone
-- else's). 'annual' is the only type with a real entitled/remaining
-- figure (see file header); every other type only ever returns
-- usedDays for visibility.
-- ============================================================
create or replace function public.get_prosm_time_leave_balance(p_user_id uuid default null, p_year integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_target_id uuid;
    v_year integer;
    v_annual_entitled numeric;
    v_result jsonb := '[]'::jsonb;
    v_type text;
    v_used numeric;
    v_pending numeric;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    v_target_id := coalesce(p_user_id, v_caller_id);
    v_org := public.current_prosm_time_organization_id();
    v_year := coalesce(p_year, extract(year from current_date)::integer);

    if v_target_id <> v_caller_id and not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS EMPLOYEE''S LEAVE BALANCE';
    end if;

    for v_type in select unnest(array['annual', 'sick', 'unpaid', 'emergency', 'other']) loop
        select coalesce(sum(days_count), 0) into v_used
        from leave_requests
        where user_id = v_target_id and leave_type = v_type and status = 'approved'
          and extract(year from start_date) = v_year;

        select coalesce(sum(days_count), 0) into v_pending
        from leave_requests
        where user_id = v_target_id and leave_type = v_type and status = 'pending'
          and extract(year from start_date) = v_year;

        if v_type = 'annual' then
            select entitled_days into v_annual_entitled from leave_entitlements where user_id = v_target_id and leave_type = 'annual' and year = v_year;
            if v_annual_entitled is null then
                select default_annual_leave_days into v_annual_entitled from organization_settings where organization_id = v_org;
                v_annual_entitled := coalesce(v_annual_entitled, 0);
            end if;
            v_result := v_result || jsonb_build_object('leaveType', v_type, 'entitledDays', v_annual_entitled, 'usedDays', v_used, 'pendingDays', v_pending, 'remainingDays', v_annual_entitled - v_used - v_pending);
        else
            v_result := v_result || jsonb_build_object('leaveType', v_type, 'entitledDays', null, 'usedDays', v_used, 'pendingDays', v_pending, 'remainingDays', null);
        end if;
    end loop;

    return jsonb_build_object('success', true, 'year', v_year, 'balances', v_result);
exception
    when others then
        raise exception 'GET PROSM TIME LEAVE BALANCE FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- set_prosm_time_leave_entitlement - Owner/HR-authority sets an
-- employee's annual entitlement for a specific year (overriding the
-- organization's own default_annual_leave_days for that one person/
-- year - a new hire's pro-rated first year, a negotiated extra
-- allowance, etc.).
-- ============================================================
create or replace function public.set_prosm_time_leave_entitlement(
    p_user_id uuid,
    p_leave_type text,
    p_year integer,
    p_entitled_days numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO SET LEAVE ENTITLEMENTS';
    end if;
    if p_leave_type not in ('annual', 'sick', 'unpaid', 'emergency', 'other') then
        raise exception 'INVALID LEAVE TYPE';
    end if;
    if p_entitled_days < 0 then
        raise exception 'ENTITLED DAYS CANNOT BE NEGATIVE';
    end if;

    v_org := public.current_prosm_time_organization_id();

    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;

    insert into leave_entitlements (organization_id, user_id, leave_type, year, entitled_days, set_by)
    values (v_org, p_user_id, p_leave_type, p_year, p_entitled_days, v_caller_id)
    on conflict (user_id, leave_type, year) do update set
        entitled_days = excluded.entitled_days, set_by = excluded.set_by, updated_at = now();

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME LEAVE ENTITLEMENT FAILED: %', sqlerrm;
end;
$function$;

-- ============================================================
-- list_prosm_time_pending_leave_requests - Manager Console's own
-- review queue, same "supervisor authority" gate as the others here.
-- ============================================================
create or replace function public.list_prosm_time_pending_leave_requests()
returns table (
    id uuid,
    user_id uuid,
    employee_name text,
    leave_type text,
    start_date date,
    end_date date,
    days_count numeric,
    reason text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE LEAVE REVIEW QUEUE';
    end if;

    v_org := public.current_prosm_time_organization_id();

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, lr.created_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    where lr.organization_id = v_org and lr.status = 'pending'
    order by lr.created_at asc;
end;
$function$;

revoke execute on function public.request_prosm_time_leave(text, date, date, text) from public, anon;
revoke execute on function public.cancel_prosm_time_leave_request(uuid) from public, anon;
revoke execute on function public.review_prosm_time_leave(uuid, text, text) from public, anon;
revoke execute on function public.get_prosm_time_leave_balance(uuid, integer) from public, anon;
revoke execute on function public.set_prosm_time_leave_entitlement(uuid, text, integer, numeric) from public, anon;
revoke execute on function public.list_prosm_time_pending_leave_requests() from public, anon;

commit;
