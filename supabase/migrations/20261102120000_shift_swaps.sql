-- 2026-11-02 (plan stage 8.3): an employee asks to hand a scheduled shift to a
-- colleague at the same site, a manager decides; and the roster shows what really
-- happened beside what was planned.
-- Rollback: drop the five functions below and shift_swap_requests.

begin;

create table public.shift_swap_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    assignment_id uuid not null references public.shift_assignments(id) on delete cascade,
    from_user_id uuid references public.users(id) on delete set null,
    to_user_id uuid references public.users(id) on delete set null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
    reason text,
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create unique index shift_swap_requests_one_pending on public.shift_swap_requests (assignment_id) where status = 'pending';
create index shift_swap_requests_org_idx on public.shift_swap_requests (organization_id, status);

alter table public.shift_swap_requests enable row level security;
revoke all on public.shift_swap_requests from anon, authenticated;

create or replace function public.prosm_time_can_manage_site_shifts(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'schedules.manage')
            and p_site_id = any(public.current_prosm_time_managed_site_ids()));
$$;
revoke all on function public.prosm_time_can_manage_site_shifts(uuid) from public, anon, authenticated;

-- The people a shift can go to: others assigned to its site.
create or replace function public.list_prosm_time_swap_colleagues(p_assignment_id uuid)
returns table (user_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_shift shift_assignments%rowtype;
begin
    select * into v_shift from shift_assignments where id = p_assignment_id and organization_id = public.current_prosm_time_organization_id();
    if v_shift.id is null or v_shift.user_id <> public.current_prosm_time_user_id() then raise exception 'SHIFT NOT FOUND'; end if;
    return query
    select u.id, u.full_name from site_assignments sa join users u on u.id = sa.user_id
    where sa.site_id = v_shift.site_id and u.id <> v_shift.user_id and u.status = 'active'
    order by u.full_name;
end;
$$;
revoke all on function public.list_prosm_time_swap_colleagues(uuid) from public, anon;
grant execute on function public.list_prosm_time_swap_colleagues(uuid) to authenticated;

create or replace function public.request_prosm_time_shift_swap(p_assignment_id uuid, p_to_user_id uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_shift shift_assignments%rowtype;
    v_id uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_shift from shift_assignments where id = p_assignment_id and organization_id = public.current_prosm_time_organization_id();
    if v_shift.id is null or v_shift.user_id <> v_me then raise exception 'SHIFT NOT FOUND'; end if;
    if v_shift.status <> 'scheduled' or v_shift.shift_date < current_date then raise exception 'THIS SHIFT CAN NO LONGER BE SWAPPED'; end if;
    if p_to_user_id = v_me or not exists (select 1 from site_assignments where site_id = v_shift.site_id and user_id = p_to_user_id) then
        raise exception 'THIS COLLEAGUE IS NOT AT THIS SITE';
    end if;
    if exists (select 1 from shift_swap_requests where assignment_id = p_assignment_id and status = 'pending') then
        raise exception 'THIS SHIFT ALREADY HAS A SWAP REQUEST';
    end if;
    insert into shift_swap_requests (organization_id, assignment_id, from_user_id, to_user_id, reason)
    values (v_shift.organization_id, p_assignment_id, v_me, p_to_user_id, nullif(trim(coalesce(p_reason, '')), ''))
    returning id into v_id;
    return v_id;
end;
$$;
revoke all on function public.request_prosm_time_shift_swap(uuid, uuid, text) from public, anon;
grant execute on function public.request_prosm_time_shift_swap(uuid, uuid, text) to authenticated;

create or replace function public.list_prosm_time_shift_swaps()
returns table (id uuid, status text, reason text, shift_date date, start_time time, end_time time, site_id uuid, site_name text, from_name text, to_name text, can_decide boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return query
    select r.id, r.status, r.reason, sa.shift_date, sa.start_time, sa.end_time, sa.site_id, s.name, fu.full_name, tu.full_name,
           r.status = 'pending' and public.prosm_time_can_manage_site_shifts(sa.site_id), r.created_at
    from shift_swap_requests r
    join shift_assignments sa on sa.id = r.assignment_id
    join sites s on s.id = sa.site_id
    left join users fu on fu.id = r.from_user_id
    left join users tu on tu.id = r.to_user_id
    where r.organization_id = public.current_prosm_time_organization_id()
      and (r.from_user_id = v_me or r.to_user_id = v_me or public.prosm_time_can_manage_site_shifts(sa.site_id))
    order by r.status = 'pending' desc, r.created_at desc
    limit 50;
end;
$$;
revoke all on function public.list_prosm_time_shift_swaps() from public, anon;
grant execute on function public.list_prosm_time_shift_swaps() to authenticated;

create or replace function public.decide_prosm_time_shift_swap(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request shift_swap_requests%rowtype;
    v_shift shift_assignments%rowtype;
    v_start timestamp;
    v_end timestamp;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_request from shift_swap_requests where id = p_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'SWAP REQUEST NOT FOUND'; end if;
    if v_request.status <> 'pending' then raise exception 'THIS SWAP REQUEST WAS ALREADY DECIDED'; end if;
    select * into v_shift from shift_assignments where id = v_request.assignment_id for update;
    if not public.prosm_time_can_manage_site_shifts(v_shift.site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;

    if p_approve then
        if v_shift.status <> 'scheduled' or v_request.to_user_id is null then raise exception 'THIS SHIFT CAN NO LONGER BE SWAPPED'; end if;
        if exists (
            select 1 from leave_requests where user_id = v_request.to_user_id and status = 'approved'
              and v_shift.shift_date between start_date and end_date
        ) then
            raise exception 'THIS EMPLOYEE IS ON APPROVED LEAVE ON THIS DATE';
        end if;
        v_start := v_shift.shift_date + v_shift.start_time;
        v_end := v_shift.shift_date + v_shift.end_time + (case when v_shift.end_time <= v_shift.start_time then interval '1 day' else interval '0' end);
        if exists (
            select 1 from shift_assignments sa
            where sa.user_id = v_request.to_user_id and sa.status = 'scheduled'
              and sa.shift_date between v_shift.shift_date - 1 and v_shift.shift_date + 1
              and v_start < (sa.shift_date + sa.end_time + (case when sa.end_time <= sa.start_time then interval '1 day' else interval '0' end))
              and v_end > (sa.shift_date + sa.start_time)
        ) then
            raise exception 'THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE';
        end if;
        update shift_assignments set user_id = v_request.to_user_id, updated_at = now() where id = v_shift.id;
        perform public.create_prosm_time_notification(
            v_shift.organization_id, v_request.to_user_id, 'shift_assigned', 'normal', 'A new shift was scheduled for you',
            'You are scheduled on ' || v_shift.shift_date::text || ' from ' || v_shift.start_time::text || ' to ' || v_shift.end_time::text || '.',
            'shift_assignments', v_shift.id,
            jsonb_build_object('shiftDate', v_shift.shift_date, 'startTime', v_shift.start_time, 'endTime', v_shift.end_time, 'crossesMidnight', v_shift.end_time <= v_shift.start_time)
        );
        if v_request.from_user_id is not null then
            perform public.create_prosm_time_notification(
                v_shift.organization_id, v_request.from_user_id, 'shift_assigned', 'normal', 'A scheduled shift was cancelled',
                'Your shift on ' || v_shift.shift_date::text || ' was cancelled.',
                'shift_assignments', v_shift.id, jsonb_build_object('shiftDate', v_shift.shift_date, 'cancelled', true)
            );
        end if;
    end if;

    update shift_swap_requests set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = v_me, reviewed_at = now() where id = p_id;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, new_state)
    values (v_shift.organization_id, v_me, case when p_approve then 'schedule.swap_approved' else 'schedule.swap_rejected' end, 'shift_swap_requests', p_id, 'Shift swap decided',
            jsonb_build_object('assignmentId', v_shift.id, 'fromUserId', v_request.from_user_id, 'toUserId', v_request.to_user_id));
end;
$$;
revoke all on function public.decide_prosm_time_shift_swap(uuid, boolean) from public, anon;
grant execute on function public.decide_prosm_time_shift_swap(uuid, boolean) to authenticated;

-- Planned beside actual: the first clock-in and last clock-out of each shift's day.
create or replace function public.list_prosm_time_shift_actuals(p_site_id uuid, p_start_date date, p_end_date date)
returns table (assignment_id uuid, first_in timestamptz, last_out timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.prosm_time_can_manage_site_shifts(p_site_id) then raise exception 'YOU DO NOT MANAGE THIS SITE'; end if;
    return query
    select sa.id, min(ats.clock_in_at), max(ats.clock_out_at)
    from shift_assignments sa
    join attendance_sessions ats on ats.user_id = sa.user_id
     and public.prosm_time_work_date(ats.clock_in_at, coalesce(ats.site_id, sa.site_id), sa.organization_id) = sa.shift_date
    where sa.site_id = p_site_id and sa.organization_id = public.current_prosm_time_organization_id()
      and sa.shift_date between p_start_date and p_end_date
    group by sa.id;
end;
$$;
revoke all on function public.list_prosm_time_shift_actuals(uuid, date, date) from public, anon;
grant execute on function public.list_prosm_time_shift_actuals(uuid, date, date) to authenticated;

commit;
