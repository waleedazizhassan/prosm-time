-- PROSM Time v2.3.43, step 9 (item 19): approving UNPAID leave records its
-- deduction automatically.
--   * the approver (leave.approve + leave.set_deduction) must give the
--     deduction per day; the app suggests it: a monthly rate / 30
--     (organization_settings.unpaid_leave_divisor), an hourly rate x the
--     hours of that day's shift (8 when unknown) - from worker_pay_rates;
--   * the days deducted leave out weekly rest days and public holidays
--     (the work calendar); per day and total, the currency, who and when are
--     kept on the request;
--   * one payroll_adjustments row per deducted day ("unpaid leave
--     deduction"), so it lands in the right pay period, in the allowance
--     sheets, reports and exports;
--   * cancelling the leave before it starts reverses it (step 8); the Owner
--     can change the amount later (audited); the employee sees it.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description)
values ('leave.set_deduction', 'leave', 'EDIT', 'Set the unpaid-leave deduction',
        'Give the deduction per day when approving unpaid leave for people at the sites one manages.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'leave.set_deduction'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

alter table public.organization_settings add column if not exists unpaid_leave_divisor numeric not null default 30 check (unpaid_leave_divisor > 0);

alter table public.leave_requests add column if not exists deduction_per_day numeric(12, 2) check (deduction_per_day >= 0);
alter table public.leave_requests add column if not exists deduction_days numeric;
alter table public.leave_requests add column if not exists deduction_total numeric(14, 2);
alter table public.leave_requests add column if not exists deduction_currency text;
alter table public.leave_requests add column if not exists deduction_set_by uuid references public.users(id) on delete set null;
alter table public.leave_requests add column if not exists deduction_set_at timestamptz;

create table if not exists public.payroll_adjustments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    kind text not null check (kind in ('unpaid_leave_deduction')),
    work_date date not null,
    amount numeric(12, 2) not null,
    currency text not null default 'EGP',
    source_type text not null,
    source_id uuid not null,
    status text not null default 'active' check (status in ('active', 'reversed')),
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    reversed_by uuid references public.users(id) on delete set null,
    reversed_at timestamptz,
    reason text
);
create index if not exists payroll_adjustments_user_date_idx on public.payroll_adjustments (user_id, work_date);
create index if not exists payroll_adjustments_source_idx on public.payroll_adjustments (source_type, source_id);

alter table public.payroll_adjustments enable row level security;
revoke all on public.payroll_adjustments from anon, authenticated;
grant select on public.payroll_adjustments to authenticated;
drop policy if exists "payroll adjustments visible to the person or their reviewers" on public.payroll_adjustments;
create policy "payroll adjustments visible to the person or their reviewers" on public.payroll_adjustments
for select to authenticated using (
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

-- The days of a leave that are deducted: not weekly rest days, not holidays.
create or replace function public.prosm_time_leave_deduction_days(p_request leave_requests)
returns date[]
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce(array_agg(d::date order by d), array[]::date[])
    from generate_series(p_request.start_date, p_request.end_date, interval '1 day') d
    where public.prosm_time_day_type(
        p_request.user_id,
        (select sa.site_id from site_assignments sa where sa.user_id = p_request.user_id order by sa.created_at limit 1),
        d::date
    ) = 'workday';
$function$;

revoke all on function public.prosm_time_leave_deduction_days(leave_requests) from public, anon, authenticated;

-- The suggested deduction per day.
create or replace function public.suggest_prosm_time_leave_deduction(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_request leave_requests%rowtype;
    v_rate worker_pay_rates%rowtype;
    v_days date[];
    v_divisor numeric;
    v_hours numeric;
    v_per_day numeric;
    v_site sites%rowtype;
    v_assignment shift_assignments%rowtype;
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_request from leave_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id();
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if not (public.current_prosm_time_user_is_owner() or (
        public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'leave.approve')
        and public.prosm_time_caller_has_authority_over(v_request.user_id))) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;
    v_days := public.prosm_time_leave_deduction_days(v_request);
    select * into v_rate from worker_pay_rates
    where user_id = v_request.user_id and effective_from <= v_request.start_date and (effective_to is null or effective_to >= v_request.start_date)
    order by effective_from desc limit 1;
    select unpaid_leave_divisor into v_divisor from organization_settings where organization_id = v_request.organization_id;
    if v_rate.id is not null then
        if v_rate.rate_type = 'MONTHLY' then
            v_per_day := v_rate.rate_amount / coalesce(v_divisor, 30);
        else
            select * into v_assignment from shift_assignments where user_id = v_request.user_id and shift_date = coalesce(v_days[1], v_request.start_date) and status = 'scheduled' limit 1;
            select s.* into v_site from sites s join site_assignments sa on sa.site_id = s.id where sa.user_id = v_request.user_id order by sa.created_at limit 1;
            v_hours := coalesce(
                case when v_assignment.id is not null then extract(epoch from (v_assignment.end_time - v_assignment.start_time)) / 3600 end,
                case when v_site.shift_start_time is not null and v_site.shift_end_time is not null then extract(epoch from (v_site.shift_end_time - v_site.shift_start_time)) / 3600 end,
                8);
            if v_hours <= 0 then v_hours := v_hours + 24; end if;
            v_per_day := v_rate.rate_amount * v_hours;
        end if;
    end if;
    return jsonb_build_object(
        'perDay', case when v_per_day is null then null else round(v_per_day, 2) end,
        'currency', coalesce(v_rate.currency, 'EGP'),
        'rateType', v_rate.rate_type, 'rate', v_rate.rate_amount, 'divisor', v_divisor, 'hours', v_hours,
        'days', cardinality(v_days), 'dates', to_jsonb(v_days)
    );
end;
$function$;

revoke all on function public.suggest_prosm_time_leave_deduction(uuid) from public, anon;
grant execute on function public.suggest_prosm_time_leave_deduction(uuid) to authenticated;

-- Record (or re-record) the deduction rows of an approved unpaid leave.
create or replace function public.prosm_time_record_leave_deduction(p_request_id uuid, p_per_day numeric, p_actor uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_request leave_requests%rowtype;
    v_days date[];
    v_currency text;
    v_day date;
begin
    select * into v_request from leave_requests where id = p_request_id for update;
    v_days := public.prosm_time_leave_deduction_days(v_request);
    select coalesce((select currency from worker_pay_rates where user_id = v_request.user_id order by effective_from desc limit 1), 'EGP') into v_currency;

    update payroll_adjustments set status = 'reversed', reversed_by = p_actor, reversed_at = now(), reason = coalesce(p_reason, reason)
    where source_type = 'leave_requests' and source_id = p_request_id and status = 'active';

    if p_per_day > 0 then
        foreach v_day in array v_days loop
            insert into payroll_adjustments (organization_id, user_id, kind, work_date, amount, currency, source_type, source_id, created_by, reason)
            values (v_request.organization_id, v_request.user_id, 'unpaid_leave_deduction', v_day, -round(p_per_day, 2), v_currency, 'leave_requests', p_request_id, p_actor, p_reason);
        end loop;
    end if;

    update leave_requests set
        deduction_per_day = round(p_per_day, 2), deduction_days = cardinality(v_days),
        deduction_total = round(round(p_per_day, 2) * cardinality(v_days), 2), deduction_currency = v_currency,
        deduction_set_by = p_actor, deduction_set_at = now(), updated_at = now()
    where id = p_request_id;
end;
$function$;

revoke all on function public.prosm_time_record_leave_deduction(uuid, numeric, uuid, text) from public, anon, authenticated;

-- review_prosm_time_leave gains the deduction (required for unpaid leave on
-- approval). Same as the effective definition after 20261025170000, plus it.
drop function if exists public.review_prosm_time_leave(uuid, text, text);
create or replace function public.review_prosm_time_leave(p_request_id uuid, p_action text, p_notes text default null, p_deduction_per_day numeric default null)
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
    -- Step 8 (item 20): an approved leave is revoked only before it starts.
    if v_request.status = 'approved' and p_action = 'rejected' and public.prosm_time_leave_started(v_request) then
        raise exception 'THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED';
    end if;
    if v_request.status = 'approved' and p_action = 'approved' then
        raise exception 'THIS LEAVE REQUEST IS ALREADY APPROVED';
    end if;

    -- Step 9 (item 19): unpaid leave is approved with its deduction per day.
    if p_action = 'approved' and v_request.leave_type = 'unpaid' then
        if not public.prosm_time_user_has_permission_internal(v_caller_id, 'leave.set_deduction') then
            raise exception 'LEAVE.SET_DEDUCTION AUTHORITY REQUIRED';
        end if;
        if p_deduction_per_day is null or p_deduction_per_day < 0 then
            raise exception 'THE DEDUCTION PER DAY IS REQUIRED FOR UNPAID LEAVE';
        end if;
    end if;

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

    if p_action = 'approved' and v_request.leave_type = 'unpaid' then
        perform public.prosm_time_record_leave_deduction(p_request_id, p_deduction_per_day, v_caller_id, nullif(trim(coalesce(p_notes, '')), ''));
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, new_state)
        values (v_org, v_caller_id, v_request.user_id, 'leave.deduction_set', 'leave_requests', p_request_id, 'Unpaid leave approved with its deduction',
                (select jsonb_build_object('perDay', deduction_per_day, 'days', deduction_days, 'total', deduction_total, 'currency', deduction_currency)
                 from leave_requests where id = p_request_id));
    end if;

    if v_request.status = 'approved' and p_action = 'rejected' then
        perform public.prosm_time_after_leave_cancelled(p_request_id, v_caller_id, nullif(trim(coalesce(p_notes, '')), ''));
    end if;

    select full_name into v_caller_name from users where id = v_caller_id;
    perform public.create_prosm_time_notification(
        v_org, v_request.user_id, 'correction_reviewed', 'normal', 'Your leave request was reviewed',
        'Decision: ' || p_action || '.', 'leave_requests', p_request_id,
        jsonb_build_object('kind', 'leave', 'actionType', p_action) || case when nullif(trim(coalesce(p_notes, '')), '') is not null then jsonb_build_object('notes', trim(p_notes)) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'REVIEW PROSM TIME LEAVE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.review_prosm_time_leave(uuid, text, text, numeric) from public, anon;
grant execute on function public.review_prosm_time_leave(uuid, text, text, numeric) to authenticated, service_role;

-- Cancelling before the start reverses the deduction (and is audited).
create or replace function public.prosm_time_after_leave_cancelled(p_request_id uuid, p_actor uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_request leave_requests%rowtype;
    v_reversed integer;
begin
    select * into v_request from leave_requests where id = p_request_id;
    update payroll_adjustments set status = 'reversed', reversed_by = p_actor, reversed_at = now(), reason = coalesce(p_reason, 'leave cancelled')
    where source_type = 'leave_requests' and source_id = p_request_id and status = 'active';
    get diagnostics v_reversed = row_count;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_request.organization_id, p_actor, v_request.user_id, 'leave.approved_cancelled', 'leave_requests', p_request_id,
            'Approved leave cancelled before it started', p_reason,
            jsonb_build_object('status', 'approved', 'startDate', v_request.start_date, 'endDate', v_request.end_date, 'days', v_request.days_count,
                               'deductionTotal', v_request.deduction_total),
            jsonb_build_object('status', v_request.status, 'deductionDaysReversed', v_reversed));
end;
$function$;

-- The Owner changes the amount later (audited).
create or replace function public.adjust_prosm_time_leave_deduction(p_request_id uuid, p_deduction_per_day numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_request leave_requests%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CHANGES A RECORDED DEDUCTION'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    if p_deduction_per_day is null or p_deduction_per_day < 0 then raise exception 'THE DEDUCTION PER DAY IS REQUIRED FOR UNPAID LEAVE'; end if;
    select * into v_request from leave_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id();
    if v_request.id is null then raise exception 'LEAVE REQUEST NOT FOUND'; end if;
    if v_request.status <> 'approved' or v_request.leave_type <> 'unpaid' then raise exception 'ONLY APPROVED UNPAID LEAVE HAS A DEDUCTION'; end if;
    perform public.prosm_time_record_leave_deduction(p_request_id, p_deduction_per_day, public.current_prosm_time_user_id(), v_reason);
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_request.organization_id, public.current_prosm_time_user_id(), v_request.user_id, 'leave.deduction_changed', 'leave_requests', p_request_id,
            'Unpaid leave deduction changed', v_reason,
            jsonb_build_object('perDay', v_request.deduction_per_day, 'total', v_request.deduction_total),
            (select jsonb_build_object('perDay', deduction_per_day, 'total', deduction_total) from leave_requests where id = p_request_id));
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.adjust_prosm_time_leave_deduction(uuid, numeric, text) from public, anon;
grant execute on function public.adjust_prosm_time_leave_deduction(uuid, numeric, text) to authenticated;

-- The deductions of a person over a period (allowance sheets, payslips, reports).
create or replace function public.list_prosm_time_payroll_adjustments(p_user_id uuid, p_from date, p_to date)
returns table (id uuid, user_id uuid, kind text, work_date date, amount numeric, currency text, source_type text, source_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return query
    select a.id, a.user_id, a.kind, a.work_date, a.amount, a.currency, a.source_type, a.source_id
    from payroll_adjustments a
    where a.organization_id = public.current_prosm_time_organization_id()
      and a.status = 'active' and a.work_date between p_from and p_to
      and (p_user_id is null or a.user_id = p_user_id)
      and (a.user_id = public.current_prosm_time_user_id() or public.current_prosm_time_user_is_owner()
           or (public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'leave.approve') and public.prosm_time_caller_has_authority_over(a.user_id)))
    order by a.user_id, a.work_date;
end;
$function$;

revoke all on function public.list_prosm_time_payroll_adjustments(uuid, date, date) from public, anon;
grant execute on function public.list_prosm_time_payroll_adjustments(uuid, date, date) to authenticated;

commit;
