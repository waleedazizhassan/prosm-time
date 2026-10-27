-- v2.3.54 (owner 2026-10-27: "an employee was absent without sending a
-- leave request - he may have asked by phone - I want to give him leave:
-- turn his absence into leave, and his timesheet with it"):
-- grant_prosm_time_leave records an approved leave for someone the caller
-- may review leave for (leave.approve and authority over the person, never
-- oneself), on any dates including past ones. It is recorded as a request
-- made on the person's behalf (recorded_by) and approved through
-- review_prosm_time_leave, so everything an approval does follows: the
-- unpaid-leave deduction, the notification, the email, and the absence
-- leaving the dashboard. No document is required (it was asked by phone);
-- the type must exist and, when the type enforces it, the balance must
-- allow it. A timesheet still in draft for those dates is generated again
-- so it shows the leave; a submitted or approved one is reported back to
-- be reopened.

begin;

alter table public.leave_requests add column if not exists recorded_by uuid references public.users(id) on delete set null;
comment on column public.leave_requests.recorded_by is 'Set when a manager recorded this leave on the person''s behalf (grant_prosm_time_leave).';

create or replace function public.grant_prosm_time_leave(
    p_user_id uuid,
    p_leave_type text,
    p_start_date date,
    p_end_date date,
    p_notes text default null,
    p_deduction_per_day numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_type leave_types%rowtype;
    v_days numeric;
    v_ent jsonb;
    v_used numeric;
    v_request_id uuid;
    v_notes text := nullif(trim(coalesce(p_notes, '')), '');
    v_sheet record;
    v_regenerated integer := 0;
    v_locked integer := 0;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'leave.approve') then
        raise exception 'YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS';
    end if;
    if p_user_id = v_caller then raise exception 'YOU CANNOT GRANT LEAVE TO YOURSELF'; end if;
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org and is_active) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if p_start_date is null or p_end_date is null then raise exception 'START AND END DATE ARE REQUIRED'; end if;
    if p_end_date < p_start_date then raise exception 'END DATE MUST NOT BE BEFORE START DATE'; end if;
    if p_end_date - p_start_date > 92 then raise exception 'CHOOSE A PERIOD OF UP TO THREE MONTHS'; end if;

    select * into v_type from leave_types where organization_id = v_org and key = p_leave_type and is_active;
    if v_type.id is null then raise exception 'INVALID LEAVE TYPE'; end if;
    v_days := (p_end_date - p_start_date) + 1;

    if exists (
        select 1 from leave_requests
        where user_id = p_user_id and status in ('pending', 'approved') and p_start_date <= end_date and p_end_date >= start_date
    ) then
        raise exception 'THIS EMPLOYEE ALREADY HAS A PENDING OR APPROVED LEAVE ON THESE DATES';
    end if;

    if v_type.enforce_balance then
        v_ent := public.prosm_time_leave_entitlement(p_user_id, v_type, extract(year from p_start_date)::integer);
        select coalesce(sum(days_count), 0) into v_used from leave_requests
        where user_id = p_user_id and leave_type = p_leave_type and status in ('pending', 'approved') and extract(year from start_date) = extract(year from p_start_date);
        if (v_ent ->> 'entitled') is not null and v_used + v_days > (v_ent ->> 'entitled')::numeric then
            raise exception 'NOT ENOUGH LEAVE BALANCE';
        end if;
    end if;

    insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, reason, recorded_by)
    values (v_org, p_user_id, p_leave_type, p_start_date, p_end_date, v_days, v_notes, v_caller)
    returning id into v_request_id;

    -- the approval itself: deduction, notification and email as for any approved request
    perform public.review_prosm_time_leave(v_request_id, 'approved', v_notes, p_deduction_per_day);

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
    values (v_org, v_caller, p_user_id, 'leave.granted_on_behalf', 'leave_requests', v_request_id, 'Leave recorded on the employee''s behalf',
            jsonb_build_object('leaveType', p_leave_type, 'startDate', p_start_date, 'endDate', p_end_date, 'days', v_days));

    -- the timesheets covering these dates show the leave
    for v_sheet in
        select id, status, period_start, period_end from timesheets
        where user_id = p_user_id and period_start <= p_end_date and period_end >= p_start_date
    loop
        if v_sheet.status = 'draft' then
            begin
                perform public.generate_prosm_time_timesheet(p_user_id, v_sheet.period_start, v_sheet.period_end);
                v_regenerated := v_regenerated + 1;
            exception when others then
                v_locked := v_locked + 1;
            end;
        else
            v_locked := v_locked + 1;
        end if;
    end loop;

    return jsonb_build_object('success', true, 'requestId', v_request_id, 'days', v_days,
                              'timesheetsUpdated', v_regenerated, 'timesheetsToReopen', v_locked);
exception
    when others then
        raise exception 'GRANT PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.grant_prosm_time_leave(uuid, text, date, date, text, numeric) from public, anon;
grant execute on function public.grant_prosm_time_leave(uuid, text, date, date, text, numeric) to authenticated;

commit;
