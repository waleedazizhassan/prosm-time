-- Owner 2026-10-18: permission review for every tier. Found: what a
-- Manager or Supervisor can SEE was already limited to the sites they
-- manage, but several of their ACTIONS still worked across the whole
-- organisation - e.g. a Supervisor could approve the leave or review the
-- exceptions of someone at another site, a Manager could generate a
-- timesheet for anyone (and then read their hours), and every
-- attendance.view holder could read every timesheet.
--
-- The rule now, everywhere: the Owner has authority over the whole
-- organisation; a Manager or Supervisor has authority over people ranked
-- below them (the same rule as acting on someone's behalf) who belong to
-- a site they manage - for an item tied to a shift, the shift's site (or
-- its responsible site), otherwise the person's assigned sites. Viewing
-- follows the same sites (no rank rule), and the read-only role keeps its
-- organisation-wide view. An SOS can be marked handled by anyone in
-- charge of its site. Exported report files are listed to whoever made
-- them and to the Owner.

begin;

-- Someone the caller may act on (approve, review, set, generate).
create or replace function public.prosm_time_caller_has_authority_over(p_subject_user_id uuid, p_site_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from users u
        where u.id = p_subject_user_id
          and u.organization_id = public.current_prosm_time_organization_id()
          and (
              public.current_prosm_time_user_is_owner()
              or (
                  public.prosm_time_can_act_on_behalf_of(public.current_prosm_time_user_id(), u.id)
                  and case
                      when p_site_id is not null then p_site_id = any(public.current_prosm_time_managed_site_ids())
                      else exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
                  end
              )
          )
    );
$function$;

-- Someone whose records the caller may read.
create or replace function public.prosm_time_caller_sees_person(p_subject_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
    select exists (
        select 1 from users u
        where u.id = p_subject_user_id
          and u.organization_id = public.current_prosm_time_organization_id()
          and (
              u.id = public.current_prosm_time_user_id()
              or public.current_prosm_time_user_is_owner()
              or public.current_prosm_time_user_role_key() = 'read_only'
              or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
              or exists (
                  select 1 from attendance_sessions s
                  where s.user_id = u.id and s.status = 'clocked_in'
                    and coalesce(s.site_id, s.responsible_site_id) = any(public.current_prosm_time_managed_site_ids())
              )
          )
    );
$function$;

revoke execute on function public.prosm_time_caller_has_authority_over(uuid, uuid) from public, anon;
revoke execute on function public.prosm_time_caller_sees_person(uuid) from public, anon;
grant execute on function public.prosm_time_caller_has_authority_over(uuid, uuid) to authenticated, service_role;
grant execute on function public.prosm_time_caller_sees_person(uuid) to authenticated, service_role;

-- Timesheets and timesheet corrections: only of people the caller sees.
drop policy if exists "timesheets visible to subject or timesheet permission holders" on public.timesheets;
create policy "timesheets visible to subject or timesheet permission holders" on public.timesheets
for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and public.prosm_time_caller_sees_person(user_id)
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

drop policy if exists "timesheet corrections visible to subject or timesheet permissio" on public.timesheet_corrections;
create policy "timesheet corrections visible to subject or timesheet permissio" on public.timesheet_corrections
for select to authenticated
using (
    requested_by = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and public.prosm_time_caller_sees_person((select ts.user_id from public.timesheets ts where ts.id = timesheet_id))
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.correct' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- Report export history: whoever made the file, and the Owner.
drop policy if exists "report exports visible to exporter or management scope" on public.report_exports;
create policy "report exports visible to exporter or management scope" on public.report_exports
for select to authenticated
using (
    exported_by = public.current_prosm_time_user_id()
    or (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner())
);

CREATE OR REPLACE FUNCTION public.review_prosm_time_exception(p_kind text, p_target_id uuid, p_action_type text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_action_id uuid;
    v_ge geofence_exceptions%rowtype;
    v_cr correction_requests%rowtype;
    v_session attendance_sessions%rowtype;
    v_ot offline_time_reviews%rowtype;
    v_mock mock_location_flags%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'EXCEPTIONS.MANAGE AUTHORITY REQUIRED';
    end if;

    if p_kind not in ('geofence_exception', 'correction_request', 'offline_time', 'mock_location') then
        raise exception 'INVALID KIND';
    end if;
    if p_action_type not in ('approved', 'rejected', 'acknowledged', 'clarification_requested') then
        raise exception 'INVALID ACTION TYPE';
    end if;

    -- Audit 1.4 - an offline action recorded with the device's time: the
    -- decision is kept on the review itself (the recorded time stays; a
    -- correction request or an admin edit changes it when needed).
    -- Audit 2.4 - a clock in/out from a location the device reported as simulated.
    if p_kind = 'mock_location' then
        select * into v_mock from mock_location_flags where id = p_target_id and organization_id = v_caller_org;
        if v_mock.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_mock.user_id, v_mock.site_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        update mock_location_flags
        set status = case p_action_type when 'clarification_requested' then 'pending_review' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_mock.user_id, 'correction_reviewed', 'normal', 'Your location was reviewed',
            'Decision: ' || p_action_type || '.', 'mock_location_flags', p_target_id,
            jsonb_build_object('kind', 'mock_location', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'offline_time' then
        select * into v_ot from offline_time_reviews where id = p_target_id and organization_id = v_caller_org;
        if v_ot.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_ot.user_id, v_ot.site_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        update offline_time_reviews
        set status = case p_action_type when 'clarification_requested' then 'pending' else p_action_type end,
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = p_notes
        where id = p_target_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_ot.user_id, 'correction_reviewed', 'normal', 'Your offline time was reviewed',
            'Decision: ' || p_action_type || '.', 'offline_time_reviews', p_target_id,
            jsonb_build_object('kind', 'offline_time', 'actionType', p_action_type)
        );
        return jsonb_build_object('success', true, 'actionId', p_target_id);
    end if;

    if p_kind = 'geofence_exception' then
        select * into v_ge from geofence_exceptions where id = p_target_id and organization_id = v_caller_org;
        if v_ge.id is null then raise exception 'EXCEPTION NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_ge.user_id, coalesce(
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_events ae join attendance_sessions ats on ats.id = ae.session_id where ae.id = v_ge.attendance_event_id),
            (select coalesce(ps.site_id, ats.site_id, ats.responsible_site_id) from presence_sessions ps left join attendance_sessions ats on ats.id = ps.attendance_session_id where ps.id = v_ge.presence_session_id)
        )) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        insert into exception_actions (organization_id, geofence_exception_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update geofence_exceptions set status = 'resolved' where id = p_target_id and p_action_type in ('approved', 'rejected', 'acknowledged');

        perform public.create_prosm_time_notification(
            v_caller_org, v_ge.user_id, 'correction_reviewed', 'normal', 'Your exception was reviewed',
            'Decision: ' || p_action_type || '.', 'geofence_exceptions', p_target_id,
            jsonb_build_object('kind', 'exception', 'actionType', p_action_type)
        );
    else
        select * into v_cr from correction_requests where id = p_target_id and organization_id = v_caller_org;
        if v_cr.id is null then raise exception 'CORRECTION REQUEST NOT FOUND'; end if;
        if not public.prosm_time_caller_has_authority_over(v_cr.user_id,
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = v_cr.attendance_session_id)
        ) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;

        insert into exception_actions (organization_id, correction_request_id, actor_user_id, action_type, notes)
        values (v_caller_org, p_target_id, v_caller_id, p_action_type, p_notes)
        returning id into v_action_id;

        update correction_requests set status = p_action_type where id = p_target_id;

        -- § live UX review, user-directed - approving now actually
        -- applies the proposed time, not just a recorded decision.
        if p_action_type = 'approved' then
            select * into v_session from attendance_sessions where id = v_cr.attendance_session_id;
            if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;

            if v_cr.proposed_event_type = 'clock_in' then
                if v_session.clock_out_at is not null and v_cr.proposed_correct_time >= v_session.clock_out_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_in_at = v_cr.proposed_correct_time, updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_in';
            else
                if v_cr.proposed_correct_time <= v_session.clock_in_at then
                    raise exception 'PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION';
                end if;

                update attendance_sessions set clock_out_at = v_cr.proposed_correct_time, status = 'clocked_out', updated_at = now() where id = v_cr.attendance_session_id;
                update attendance_events set occurred_at = v_cr.proposed_correct_time where session_id = v_cr.attendance_session_id and event_type = 'clock_out';

                -- Same cleanup clock_out_prosm_time_attendance's own
                -- self-service path already does - a retroactive
                -- clock-out correction shouldn't leave presence
                -- monitoring running against someone no longer "at work".
                update presence_sessions
                set status = 'ended', ended_at = now(), end_reason = 'clock_out'
                where attendance_session_id = v_cr.attendance_session_id and status = 'active';
            end if;
        end if;

        perform public.create_prosm_time_notification(
            v_caller_org, v_cr.user_id, 'correction_reviewed', 'normal', 'Your correction request was reviewed',
            'Decision: ' || p_action_type || '.', 'correction_requests', p_target_id,
            jsonb_build_object('kind', 'correction', 'actionType', p_action_type)
        );
    end if;

    return jsonb_build_object('success', true, 'actionId', v_action_id);
exception
    when others then
        raise exception 'REVIEW PROSM TIME EXCEPTION FAILED: %', sqlerrm;
end;
$function$;

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
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
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
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
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
    if not public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage') then
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
        public.prosm_time_user_has_permission_internal(v_caller_id, 'exceptions.manage')
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

CREATE OR REPLACE FUNCTION public.resolve_prosm_time_sos_alert(p_sos_alert_id uuid, p_resolution_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_alert sos_alerts%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    select * into v_alert from sos_alerts where id = p_sos_alert_id and organization_id = v_caller_org;
    if v_alert.id is null then
        raise exception 'SOS ALERT NOT FOUND';
    end if;
    -- An emergency: anyone in charge of the alert's site may mark it handled (no rank rule).
    if not (
        public.current_prosm_time_user_is_owner()
        or v_alert.site_id = any(public.current_prosm_time_managed_site_ids())
        or (v_alert.site_id is null and public.current_prosm_time_caller_manages_users_site(v_alert.user_id))
    ) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;

    if v_alert.status <> 'active' then
        raise exception 'THIS SOS ALERT IS ALREADY RESOLVED';
    end if;

    update sos_alerts
    set status = 'resolved', resolved_at = now(), resolved_by = v_caller_id, resolution_notes = p_resolution_notes
    where id = p_sos_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, v_alert.user_id, 'SOS_ALERT_RESOLVED', 'sos_alerts', p_sos_alert_id,
        'SOS alert marked resolved.'
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'RESOLVE PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.end_prosm_time_presence_session(p_presence_session_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_session presence_sessions%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    if p_reason is null or length(trim(p_reason)) = 0 then
        raise exception 'REASON IS REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id and organization_id = v_caller_org;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;
    if not public.prosm_time_caller_has_authority_over(v_session.user_id, coalesce(
        v_session.site_id,
        (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_sessions ats where ats.id = v_session.attendance_session_id)
    )) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS ALREADY ENDED';
    end if;

    update presence_sessions set status = 'ended', ended_at = now(), end_reason = 'manual_termination' where id = p_presence_session_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_session.user_id, 'PRESENCE_SESSION_TERMINATED', 'presence_sessions', p_presence_session_id,
        'Presence monitoring ended by controlled termination.', p_reason
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'END PROSM TIME PRESENCE SESSION FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.generate_prosm_time_timesheet(p_user_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
    v_org_threshold integer;
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
            public.current_prosm_time_user_is_owner()
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

    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = v_org_id;

    with rejected_exception_cap as (
        -- The earliest violation, per session, whose MOST RECENT
        -- review decision was a rejection (a later approval on
        -- re-review correctly lifts an earlier rejection's cap).
        select
            coalesce(ae.session_id, ps.attendance_session_id) as session_id,
            min(ge.created_at) as cap_at
        from geofence_exceptions ge
        left join attendance_events ae on ae.id = ge.attendance_event_id
        left join presence_sessions ps on ps.id = ge.presence_session_id
        where ge.user_id = p_user_id
        and exists (
            select 1 from exception_actions ea
            where ea.geofence_exception_id = ge.id
            and ea.action_type = 'rejected'
            and ea.created_at = (select max(ea2.created_at) from exception_actions ea2 where ea2.geofence_exception_id = ge.id)
        )
        group by coalesce(ae.session_id, ps.attendance_session_id)
    ),
    capped_sessions as (
        select
            ats.id as session_id,
            ats.clock_in_at,
            ats.site_id,
            least(coalesce(ats.clock_out_at, now()), coalesce(rec.cap_at, coalesce(ats.clock_out_at, now()))) as effective_clock_out_at
        from attendance_sessions ats
        left join rejected_exception_cap rec on rec.session_id = ats.id
        where ats.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end
    ),
    worked_by_day as (
        select
            cs.clock_in_at::date as work_date,
            sum(extract(epoch from (cs.effective_clock_out_at - cs.clock_in_at)) / 60) as worked_minutes
        from capped_sessions cs
        group by cs.clock_in_at::date
    ),
    threshold_by_day as (
        select distinct on (cs.clock_in_at::date)
            cs.clock_in_at::date as work_date,
            s.daily_overtime_threshold_minutes as site_threshold,
            s.overtime_start_time,
            s.late_deduction_start_time,
            s.timezone as site_timezone,
            cs.clock_in_at as rep_clock_in_at,
            cs.effective_clock_out_at as rep_clock_out_at
        from capped_sessions cs
        join sites s on s.id = cs.site_id
        order by cs.clock_in_at::date, cs.clock_in_at desc
    )
    select
        coalesce(sum(w.worked_minutes), 0),
        coalesce(sum(
            case
                when t.overtime_start_time is not null and t.rep_clock_out_at is not null then
                    greatest(extract(epoch from ((t.rep_clock_out_at at time zone t.site_timezone)::time - t.overtime_start_time)) / 60, 0)
                else
                    greatest(w.worked_minutes - coalesce(t.site_threshold, v_org_threshold, 480), 0)
            end
        ), 0),
        coalesce(sum(
            case
                when t.late_deduction_start_time is not null then
                    greatest(extract(epoch from ((t.rep_clock_in_at at time zone t.site_timezone)::time - t.late_deduction_start_time)) / 60, 0)
                else 0
            end
        ), 0)
    into v_worked_minutes, v_overtime_minutes, v_deduction_minutes
    from worked_by_day w
    left join threshold_by_day t on t.work_date = w.work_date;

    select coalesce(sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60), 0)
    into v_break_minutes
    from break_events be
    join attendance_sessions ats on ats.id = be.attendance_session_id
    where be.user_id = p_user_id and ats.clock_in_at::date between p_period_start and p_period_end;

    -- Approved leave overlapping this period, calendar-day-inclusive
    -- overlap (matches leave_requests.days_count's own "end - start + 1"
    -- convention) rather than the leave's own full days_count, since a
    -- single leave request can span across a period boundary.
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

    return jsonb_build_object('success', true, 'timesheetId', v_timesheet_id);
exception
    when others then
        raise exception 'GENERATE PROSM TIME TIMESHEET FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.compute_prosm_time_daily_overtime(p_user_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            and public.prosm_time_caller_sees_person(p_user_id)
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

CREATE OR REPLACE FUNCTION public.list_prosm_time_timesheet_entries(p_timesheet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            and public.prosm_time_caller_sees_person(v_timesheet.user_id)
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

CREATE OR REPLACE FUNCTION public.list_prosm_time_timesheet_evidence_pack(p_timesheet_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_timesheet timesheets%rowtype;
    v_user users%rowtype;
    v_org organizations%rowtype;
    v_approver_name text;
    v_entries jsonb;
    v_exceptions jsonb;
    v_corrections jsonb;
    v_evidence jsonb;
    v_approval_trail jsonb;
    v_timesheet_corrections jsonb;
    v_leave_entries jsonb;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;

    select * into v_timesheet from timesheets where id = p_timesheet_id;
    if v_timesheet.id is null then raise exception 'TIMESHEET NOT FOUND'; end if;

    if not (
        v_timesheet.user_id = v_caller_id
        or (
            v_timesheet.organization_id = public.current_prosm_time_organization_id()
            and public.prosm_time_caller_sees_person(v_timesheet.user_id)
            and (
                public.current_prosm_time_user_is_owner()
                or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.generate' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'timesheets.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                or 'reports.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            )
        )
    ) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THIS TIMESHEET REPORT';
    end if;

    select * into v_user from users where id = v_timesheet.user_id;
    select * into v_org from organizations where id = v_timesheet.organization_id;
    select full_name into v_approver_name from users where id = v_timesheet.approved_by;

    select coalesce(jsonb_agg(entry order by entry->>'clockInAt'), '[]'::jsonb) into v_entries
    from (
        select jsonb_build_object(
            'sessionId', ats.id,
            'siteId', ats.site_id,
            'siteName', coalesce(s.name, ats.manual_location_label),
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

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_exceptions
    from (
        select jsonb_build_object(
            'id', ge.id, 'distanceMeters', ge.distance_meters, 'reasonCategory', ge.reason_category,
            'employeeReason', ge.employee_reason, 'status', ge.status, 'createdAt', ge.created_at
        ) as row
        from geofence_exceptions ge
        where ge.user_id = v_timesheet.user_id and ge.created_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_corrections
    from (
        select jsonb_build_object(
            'id', cr.id, 'proposedEventType', cr.proposed_event_type, 'proposedCorrectTime', cr.proposed_correct_time,
            'reason', cr.reason, 'status', cr.status, 'createdAt', cr.created_at
        ) as row
        from correction_requests cr
        where cr.user_id = v_timesheet.user_id and cr.created_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'capturedAt'), '[]'::jsonb) into v_evidence
    from (
        select jsonb_build_object(
            'id', ce.id, 'attendanceEventId', ce.attendance_event_id, 'storagePath', ce.storage_path,
            'contentType', ce.content_type, 'capturedAt', ce.captured_at
        ) as row
        from camera_evidence ce
        join attendance_events ae on ae.id = ce.attendance_event_id
        where ae.user_id = v_timesheet.user_id and ae.occurred_at::date between v_timesheet.period_start and v_timesheet.period_end
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_approval_trail
    from (
        select jsonb_build_object(
            'action', ta.action, 'actorName', u.full_name, 'notes', ta.notes, 'createdAt', ta.created_at
        ) as row
        from timesheet_approvals ta
        join users u on u.id = ta.actor_user_id
        where ta.timesheet_id = p_timesheet_id
    ) rows;

    select coalesce(jsonb_agg(row order by row->>'createdAt'), '[]'::jsonb) into v_timesheet_corrections
    from (
        select jsonb_build_object(
            'id', tc.id, 'reason', tc.reason, 'status', tc.status, 'reviewNotes', tc.review_notes,
            'reviewedAt', tc.reviewed_at, 'createdAt', tc.created_at
        ) as row
        from timesheet_corrections tc
        where tc.timesheet_id = p_timesheet_id
    ) rows;

    -- § real gap fix, 2026-09-15 - leave for this period never made it
    -- into the pack at all. Overlapping-window logic (a leave spanning
    -- into or out of the period still counts), same as this codebase's
    -- own export-leave/generate-timesheet.
    select coalesce(jsonb_agg(row order by row->>'startDate'), '[]'::jsonb) into v_leave_entries
    from (
        select jsonb_build_object(
            'id', lr.id, 'leaveType', lr.leave_type, 'startDate', lr.start_date, 'endDate', lr.end_date,
            'daysCount', lr.days_count, 'status', lr.status, 'reason', lr.reason
        ) as row
        from leave_requests lr
        where lr.user_id = v_timesheet.user_id
        and lr.status = 'approved'
        and lr.start_date <= v_timesheet.period_end
        and lr.end_date >= v_timesheet.period_start
    ) rows;

    return jsonb_build_object(
        'success', true,
        'timesheet', jsonb_build_object(
            'id', v_timesheet.id,
            'periodStart', v_timesheet.period_start,
            'periodEnd', v_timesheet.period_end,
            'status', v_timesheet.status,
            'totalWorkedMinutes', v_timesheet.total_worked_minutes,
            'totalBreakMinutes', v_timesheet.total_break_minutes,
            'totalOvertimeMinutes', v_timesheet.total_overtime_minutes,
            'totalLeaveDays', v_timesheet.total_leave_days,
            'submittedAt', v_timesheet.submitted_at,
            'approvedAt', v_timesheet.approved_at,
            'lockedAt', v_timesheet.locked_at,
            'approverName', v_approver_name
        ),
        'employee', jsonb_build_object('id', v_user.id, 'fullName', v_user.full_name, 'email', v_user.email),
        'organization', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'organizationCode', v_org.organization_code),
        'entries', v_entries,
        'exceptions', v_exceptions,
        'corrections', v_corrections,
        'evidenceReferences', v_evidence,
        'approvalTrail', v_approval_trail,
        'timesheetCorrections', v_timesheet_corrections,
        'leaveEntries', v_leave_entries
    );
exception
    when others then
        raise exception 'LIST PROSM TIME TIMESHEET EVIDENCE PACK FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.review_prosm_time_timesheet_correction(p_correction_id uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            or (
                'attendance.correct' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
                and public.prosm_time_caller_has_authority_over((select ts.user_id from timesheets ts where ts.id = v_correction.timesheet_id))
            )
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

CREATE OR REPLACE FUNCTION public.create_prosm_time_shift_template(p_site_id uuid, p_name text, p_start_time time without time zone, p_end_time time without time zone, p_color text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_org uuid;
    v_template_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SHIFT TEMPLATES';
    end if;
    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'A NAME IS REQUIRED';
    end if;
    if p_end_time = p_start_time then
        raise exception 'END TIME MUST BE DIFFERENT FROM START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;
    if not public.current_prosm_time_user_is_owner() and not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    -- p_end_time <= p_start_time is a real, supported overnight
    -- template (e.g. 22:00-06:00) - not an error.
    insert into shift_templates (organization_id, site_id, name, start_time, end_time, color, created_by)
    values (v_org, p_site_id, trim(p_name), p_start_time, p_end_time, p_color, v_caller_id)
    returning id into v_template_id;

    return jsonb_build_object('success', true, 'templateId', v_template_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME SHIFT TEMPLATE FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_prosm_time_site_shifts(p_site_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(id uuid, user_id uuid, employee_name text, shift_date date, start_time time without time zone, end_time time without time zone, crosses_midnight boolean, status text, notes text, cancelled_reason text)
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
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE SITE SCHEDULE';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;
    if not public.current_prosm_time_user_is_owner() and not (p_site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    return query
    select sa.id, sa.user_id, u.full_name, sa.shift_date, sa.start_time, sa.end_time, (sa.end_time <= sa.start_time), sa.status, sa.notes, sa.cancelled_reason
    from shift_assignments sa
    join users u on u.id = sa.user_id
    where sa.organization_id = v_org and sa.site_id = p_site_id
      and sa.shift_date between p_start_date and p_end_date
    order by sa.shift_date asc, sa.start_time asc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_prosm_time_shift_template(p_template_id uuid)
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
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SHIFT TEMPLATES';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from shift_templates where id = p_template_id and organization_id = v_org) then
        raise exception 'SHIFT TEMPLATE NOT FOUND';
    end if;
    if not public.current_prosm_time_user_is_owner()
       and not exists (select 1 from shift_templates where id = p_template_id and site_id = any(public.current_prosm_time_managed_site_ids())) then
        raise exception 'YOU DO NOT MANAGE THIS SITE';
    end if;

    delete from shift_templates where id = p_template_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DELETE PROSM TIME SHIFT TEMPLATE FAILED: %', sqlerrm;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_prosm_time_report_exports(p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, report_type text, period_start date, period_end date, file_name text, storage_path text, exported_by_name text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select re.id, re.report_type, re.period_start, re.period_end, re.file_name, re.storage_path, u.full_name, re.created_at
    from report_exports re
    join users u on u.id = re.exported_by
    where re.exported_by = public.current_prosm_time_user_id()
       or (
            re.organization_id = public.current_prosm_time_organization_id()
            and public.current_prosm_time_user_is_owner()
       )
    order by re.created_at desc
    limit p_limit;
$function$;

commit;
