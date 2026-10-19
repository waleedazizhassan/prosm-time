-- Owner 2026-10-19:
-- 1. Approving leave is its own permission, leave.approve, held by Managers
--    (and the Owner) only - no longer part of "manage exceptions", so
--    Supervisors don't approve leave. Strictly per site: a Manager decides
--    only for people below them at the sites they manage, never their own
--    (a Manager's leave goes to the Owner). The leave lists, balances,
--    entitlements, who is told about a new request and what can be read
--    all follow it.
-- 2. The workers' kiosk (external workers' numbers) is run by the Owner,
--    or by a Manager at a site they manage - no longer by any signed-in
--    account.
-- 3. Exported report files: the storage rule still let every "manage
--    exceptions" holder download any exported file; now, like the list
--    (20261019110000), only whoever made it and the Owner.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('leave.approve', 'leave', 'APPROVE', 'Approve leave', 'Approve or reject leave requests and set leave entitlements for people at the sites one manages.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'leave.approve'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

drop policy if exists "members can view own leave requests" on public.leave_requests;
create policy "members can view own leave requests" on public.leave_requests
for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and public.prosm_time_caller_has_authority_over(user_id)
        )
    )
);

drop policy if exists "members can view own leave entitlements" on public.leave_entitlements;
create policy "members can view own leave entitlements" on public.leave_entitlements
for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and public.prosm_time_caller_sees_person(user_id)
        )
    )
);

drop policy if exists "report export files visible to exporter or management scope" on storage.objects;
create policy "report export files visible to exporter or management scope" on storage.objects
for select to authenticated
using (
    bucket_id = 'report-exports'
    and exists (
        select 1 from public.report_exports re
        where re.storage_path = objects.name
          and (
              re.exported_by = public.current_prosm_time_user_id()
              or (re.organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner())
          )
    )
);

CREATE OR REPLACE FUNCTION public.review_prosm_time_leave(p_request_id uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_request leave_requests%rowtype;
    v_caller_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;
    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_request from leave_requests where id = p_request_id and organization_id = v_org;
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if not public.prosm_time_caller_has_authority_over(v_request.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if v_request.status not in ('pending', 'approved') then
        raise exception 'THIS LEAVE REQUEST HAS ALREADY BEEN DECIDED';
    end if;
    if v_request.status = 'approved' and p_action = 'approved' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    -- § real bug fix, 2026-09-13 - see this migration's own header
    -- comment. Only checked on approval - rejecting never creates a
    -- conflicting state.
    if p_action = 'approved' and exists (
        select 1 from attendance_sessions
        where user_id = v_request.user_id
        and clock_in_at::date between v_request.start_date and v_request.end_date
    ) then
        raise exception 'THIS EMPLOYEE HAS ATTENDANCE RECORDED DURING THIS LEAVE PERIOD - RESOLVE THE ATTENDANCE RECORD BEFORE APPROVING';
    end if;

    update leave_requests
    set status = case when p_action = 'approved' then 'approved' else 'rejected' end,
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

CREATE OR REPLACE FUNCTION public.list_prosm_time_pending_leave_requests()
 RETURNS TABLE(id uuid, user_id uuid, employee_name text, leave_type text, start_date date, end_date date, days_count numeric, reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE LEAVE REVIEW QUEUE';
    end if;

    v_org := public.current_prosm_time_organization_id();

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, lr.created_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    where lr.organization_id = v_org and lr.status = 'pending'
      and public.prosm_time_caller_has_authority_over(lr.user_id)
    order by lr.created_at asc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_prosm_time_approved_leave_requests(p_upcoming_only boolean DEFAULT true)
 RETURNS TABLE(id uuid, user_id uuid, employee_name text, leave_type text, start_date date, end_date date, days_count numeric, reason text, reviewed_by_name text, reviewed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW APPROVED LEAVE REQUESTS';
    end if;

    v_org := public.current_prosm_time_organization_id();

    return query
    select lr.id, lr.user_id, u.full_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, ru.full_name, lr.reviewed_at
    from leave_requests lr
    join users u on u.id = lr.user_id
    left join users ru on ru.id = lr.reviewed_by
    where lr.organization_id = v_org and lr.status = 'approved'
      and public.prosm_time_caller_sees_person(lr.user_id)
      and (not p_upcoming_only or lr.end_date >= current_date)
    order by lr.start_date asc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_prosm_time_leave_entitlement(p_user_id uuid, p_leave_type text, p_year integer, p_entitled_days numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve') then
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
    if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

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

CREATE OR REPLACE FUNCTION public.get_prosm_time_leave_balance(p_user_id uuid DEFAULT NULL::uuid, p_year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    if v_target_id <> v_caller_id and not (
        public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.approve')
        and public.prosm_time_caller_sees_person(v_target_id)
    ) then
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

CREATE OR REPLACE FUNCTION public.request_prosm_time_leave(p_leave_type text, p_start_date date, p_end_date date, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_caller_name text;
    v_days numeric;
    v_request_id uuid;
    v_has_overlap boolean;
    v_caller_is_owner boolean;
    v_caller_is_reviewer boolean;
    v_notified boolean := false;
    v_has_attendance boolean;
    v_recipient record;
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
    v_caller_is_owner := public.current_prosm_time_user_is_owner();

    -- § user-directed, 2026-09-16 - the Owner's own request is
    -- exclusive: instantly self-approved, no reviewer, no wait. Same
    -- attendance-conflict guard review_prosm_time_leave already
    -- enforces for everyone else (20260913110000) - an Owner already
    -- clocked in during these dates can't auto-approve over that
    -- contradiction either; they'd need to resolve the attendance
    -- record first, same as any other approval path.
    if v_caller_is_owner then
        select exists (
            select 1 from attendance_sessions
            where user_id = v_caller_id
            and clock_in_at::date between p_start_date and p_end_date
        ) into v_has_attendance;
        if v_has_attendance then
            raise exception 'YOU HAVE ATTENDANCE RECORDED DURING THESE DATES - RESOLVE THE ATTENDANCE RECORD BEFORE REQUESTING LEAVE FOR THIS PERIOD';
        end if;

        insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, status, reviewed_by, reviewed_at)
        values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''), 'approved', v_caller_id, now())
        returning id into v_request_id;

        return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', true);
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason)
    values (v_org, v_caller_id, p_leave_type, p_start_date, p_end_date, v_days, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_request_id;

    select full_name into v_caller_name from users where id = v_caller_id;

    v_caller_is_reviewer := 'leave.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]));

    if v_caller_is_reviewer then
        for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
            );
        end loop;
    else
        for v_recipient in
            select distinct u.id from users u
            join site_assignments msa on msa.user_id = u.id and msa.role_at_site = 'manager'
            join site_assignments ssa on ssa.site_id = msa.site_id and ssa.user_id = v_caller_id
            where u.organization_id = v_org and u.is_active and not u.is_owner and u.id <> v_caller_id
              and public.prosm_time_user_has_permission_internal(u.id, 'leave.approve')
              and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_caller_id)
        loop
            v_notified := true;
            perform public.create_prosm_time_notification(
                v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                'leave_requests', v_request_id,
                jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
            );
        end loop;
        if not v_notified then
            for v_recipient in select u.id from users u where u.organization_id = v_org and u.is_owner
            loop
                perform public.create_prosm_time_notification(
                    v_org, v_recipient.id, 'exception_pending_review', 'normal', 'Leave request awaiting your review',
                    v_caller_name || ' requested ' || v_days || ' day(s) of leave.',
                    'leave_requests', v_request_id,
                    jsonb_build_object('employeeName', v_caller_name, 'kind', 'leave', 'days', v_days)
                );
            end loop;
        end if;
    end if;

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'daysCount', v_days, 'autoApproved', false);
exception
    when others then
        raise exception 'REQUEST PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_worker_clock_in(p_site_id uuid, p_worker_number text, p_latitude double precision, p_longitude double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_org uuid;
    v_worker site_workers%rowtype;
    v_open_entry site_worker_attendance%rowtype;
    v_entry_id uuid;
begin
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or (
        public.current_prosm_time_user_role_key() = 'manager' and p_site_id = any(public.current_prosm_time_managed_site_ids())
    )) then
        raise exception 'ONLY THE OWNER OR THE SITES MANAGER MAY RUN THE WORKERS KIOSK';
    end if;
    if p_latitude is null or p_longitude is null then
        raise exception 'A REAL GPS SAMPLE IS REQUIRED';
    end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org and is_active) then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO WORKER WITH THIS NUMBER';
    end if;
    if v_worker.status <> 'active' then
        raise exception 'THIS WORKER IS NOT ACTIVE';
    end if;

    select * into v_open_entry from site_worker_attendance where site_worker_id = v_worker.id and clock_out_at is null;
    if v_open_entry.id is not null then
        raise exception 'THIS WORKER IS ALREADY CLOCKED IN';
    end if;

    insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_latitude, clock_in_longitude)
    values (v_caller_org, v_worker.id, p_site_id, p_latitude, p_longitude)
    returning id into v_entry_id;

    return jsonb_build_object('success', true, 'entryId', v_entry_id, 'workerName', v_worker.full_name);
exception
    when others then
        raise exception 'KIOSK WORKER CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_worker_clock_out(p_site_id uuid, p_worker_number text, p_latitude double precision, p_longitude double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_org uuid;
    v_worker site_workers%rowtype;
    v_open_entry site_worker_attendance%rowtype;
begin
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.current_prosm_time_user_is_owner() or (
        public.current_prosm_time_user_role_key() = 'manager' and p_site_id = any(public.current_prosm_time_managed_site_ids())
    )) then
        raise exception 'ONLY THE OWNER OR THE SITES MANAGER MAY RUN THE WORKERS KIOSK';
    end if;
    if p_latitude is null or p_longitude is null then
        raise exception 'A REAL GPS SAMPLE IS REQUIRED';
    end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_caller_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    select * into v_worker from site_workers where organization_id = v_caller_org and worker_number = p_worker_number;
    if v_worker.id is null then
        raise exception 'NO WORKER WITH THIS NUMBER';
    end if;

    select * into v_open_entry from site_worker_attendance where site_worker_id = v_worker.id and clock_out_at is null order by clock_in_at desc limit 1;
    if v_open_entry.id is null then
        raise exception 'THIS WORKER IS NOT CURRENTLY CLOCKED IN';
    end if;

    update site_worker_attendance
    set clock_out_at = now(), clock_out_latitude = p_latitude, clock_out_longitude = p_longitude, updated_at = now()
    where id = v_open_entry.id;

    return jsonb_build_object('success', true, 'entryId', v_open_entry.id, 'workerName', v_worker.full_name);
exception
    when others then
        raise exception 'KIOSK WORKER CLOCK OUT FAILED: %', sqlerrm;
end;
$function$;

commit;
