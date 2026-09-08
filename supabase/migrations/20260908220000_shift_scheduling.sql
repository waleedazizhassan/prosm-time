-- PROSM Time - real advance shift scheduling/rostering, the last of
-- the 3 genuine gaps this session's own competitive research found
-- (Jibble/Deputy/Connecteam/ClockShark/Homebase - every one of them
-- has drag-and-drop shift planning; PROSM Time had none). User's own
-- explicit priority order this session: PTO/leave first (done,
-- 20260908200000), scheduling second, payroll integration deferred
-- (needs a real Intuit developer account the user hasn't set up yet).
--
-- The permission this needs already existed, unused, since Phase 1
-- (20260831130000: 'schedules.manage', already granted to the manager
-- role by default) - ManagerConsolePage.tsx's own header comment
-- already flagged "no WP in this Master File owns 'schedules' yet".
-- This is that WP.
--
-- Two tables: shift_templates (a reusable named time pattern per site -
-- "Morning 08:00-16:00") and shift_assignments (a specific employee
-- scheduled on a specific date, optionally from a template but always
-- carrying its own start/end - editing a template later never silently
-- rewrites already-scheduled shifts). Overlap prevention mirrors leave_
-- requests' own pattern (same-day time-range overlap check inside the
-- RPC, not a DB constraint - time-range exclusion constraints need the
-- btree_gist extension this schema doesn't have, and a same-day-plus-
-- time-overlap check is simple enough as plain SQL).

begin;

-- notifications.type's CHECK constraint (last extended 20260901120000,
-- confirmed the only place that touches it by name since) needs a new
-- 'shift_assigned' value for create_prosm_time_shift_template/
-- assign_prosm_time_shift/cancel_prosm_time_shift_assignment below.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
    'out_of_zone_employee', 'out_of_zone_manager', 'exception_pending_review',
    'correction_submitted', 'correction_reviewed', 'break_exceeded', 'sos_alert',
    'timesheet_submitted', 'timesheet_approved', 'timesheet_rejected',
    'timesheet_correction_requested', 'timesheet_correction_approved', 'timesheet_correction_rejected',
    'shift_assigned'
));

create table public.shift_templates (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    name text not null,
    start_time time not null,
    end_time time not null,
    color text,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index shift_templates_organization_id_idx on public.shift_templates(organization_id);
create index shift_templates_site_id_idx on public.shift_templates(site_id);

create table public.shift_assignments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid not null references public.sites(id) on delete cascade,
    shift_template_id uuid references public.shift_templates(id) on delete set null,
    shift_date date not null,
    start_time time not null,
    end_time time not null,
    notes text,
    status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
    cancelled_reason text,
    created_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint shift_assignments_valid_range check (end_time > start_time)
);

create index shift_assignments_organization_id_idx on public.shift_assignments(organization_id);
create index shift_assignments_user_id_idx on public.shift_assignments(user_id);
create index shift_assignments_site_id_idx on public.shift_assignments(site_id);
create index shift_assignments_shift_date_idx on public.shift_assignments(shift_date);

alter table public.shift_templates enable row level security;
alter table public.shift_assignments enable row level security;

revoke all on public.shift_templates from anon, authenticated;
revoke all on public.shift_assignments from anon, authenticated;
grant select on public.shift_templates to authenticated;
grant select on public.shift_assignments to authenticated;

-- Templates are org-wide reference data, not personal - every member
-- can see the shift patterns their site uses (needed just to render a
-- schedule sensibly), only schedules.manage/Owner can create them.
create policy "members can view own organization shift templates"
on public.shift_templates for select to authenticated
using (organization_id = public.current_prosm_time_organization_id());

-- Same "own rows or supervisor" shape as leave_requests (fixed this
-- same session, 20260908210000) - get_prosm_time_effective_permissions
-- is the one permission-check function actually granted to
-- authenticated; prosm_time_user_has_permission_internal is NOT (never
-- call that one from an RLS policy - see the af24a81 postmortem).
create policy "members can view own shift assignments"
on public.shift_assignments for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or public.current_prosm_time_user_is_owner()
    or 'schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
);

create or replace function public.create_prosm_time_shift_template(
    p_site_id uuid,
    p_name text,
    p_start_time time,
    p_end_time time,
    p_color text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
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
    if p_end_time <= p_start_time then
        raise exception 'END TIME MUST BE AFTER START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    insert into shift_templates (organization_id, site_id, name, start_time, end_time, color, created_by)
    values (v_org, p_site_id, trim(p_name), p_start_time, p_end_time, p_color, v_caller_id)
    returning id into v_template_id;

    return jsonb_build_object('success', true, 'templateId', v_template_id);
exception
    when others then
        raise exception 'CREATE PROSM TIME SHIFT TEMPLATE FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.delete_prosm_time_shift_template(p_template_id uuid)
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
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO MANAGE SHIFT TEMPLATES';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from shift_templates where id = p_template_id and organization_id = v_org) then
        raise exception 'SHIFT TEMPLATE NOT FOUND';
    end if;

    delete from shift_templates where id = p_template_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DELETE PROSM TIME SHIFT TEMPLATE FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.assign_prosm_time_shift(
    p_user_id uuid,
    p_site_id uuid,
    p_shift_date date,
    p_start_time time,
    p_end_time time,
    p_shift_template_id uuid default null,
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
    v_assignment_id uuid;
    v_has_overlap boolean;
    v_employee_name text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO ASSIGN SHIFTS';
    end if;
    if p_end_time <= p_start_time then
        raise exception 'END TIME MUST BE AFTER START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    select exists (
        select 1 from shift_assignments
        where user_id = p_user_id and shift_date = p_shift_date and status = 'scheduled'
          and p_start_time < end_time and p_end_time > start_time
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE';
    end if;

    insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time, notes, created_by)
    values (v_org, p_user_id, p_site_id, p_shift_template_id, p_shift_date, p_start_time, p_end_time, nullif(trim(coalesce(p_notes, '')), ''), v_caller_id)
    returning id into v_assignment_id;

    select full_name into v_employee_name from users where id = p_user_id;
    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'shift_assigned', 'normal', 'A new shift was scheduled for you',
        'You are scheduled on ' || p_shift_date::text || ' from ' || p_start_time::text || ' to ' || p_end_time::text || '.',
        'shift_assignments', v_assignment_id,
        jsonb_build_object('shiftDate', p_shift_date, 'startTime', p_start_time, 'endTime', p_end_time)
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'ASSIGN PROSM TIME SHIFT FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.cancel_prosm_time_shift_assignment(
    p_assignment_id uuid,
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
    v_assignment shift_assignments%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO CANCEL SHIFT ASSIGNMENTS';
    end if;

    v_org := public.current_prosm_time_organization_id();
    select * into v_assignment from shift_assignments where id = p_assignment_id and organization_id = v_org;
    if v_assignment.id is null then raise exception 'SHIFT ASSIGNMENT NOT FOUND'; end if;
    if v_assignment.status <> 'scheduled' then
        raise exception 'THIS SHIFT ASSIGNMENT IS ALREADY CANCELLED';
    end if;

    update shift_assignments
    set status = 'cancelled', cancelled_reason = nullif(trim(coalesce(p_reason, '')), ''), updated_at = now()
    where id = p_assignment_id;

    perform public.create_prosm_time_notification(
        v_org, v_assignment.user_id, 'shift_assigned', 'normal', 'A scheduled shift was cancelled',
        'Your shift on ' || v_assignment.shift_date::text || ' was cancelled.',
        'shift_assignments', p_assignment_id,
        jsonb_build_object('shiftDate', v_assignment.shift_date, 'cancelled', true)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'CANCEL PROSM TIME SHIFT ASSIGNMENT FAILED: %', sqlerrm;
end;
$function$;

-- Manager's own schedule view for a site - RLS already scopes the
-- underlying select correctly, but this joins in the employee name
-- (PostgREST embeds work for a plain select too, but a dedicated RPC
-- keeps the shape stable and matches list_prosm_time_pending_leave_
-- requests' own established pattern for this kind of manager-facing
-- roster read).
create or replace function public.list_prosm_time_site_shifts(
    p_site_id uuid,
    p_start_date date,
    p_end_date date
)
returns table (
    id uuid,
    user_id uuid,
    employee_name text,
    shift_date date,
    start_time time,
    end_time time,
    status text,
    notes text,
    cancelled_reason text
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
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO VIEW THE SITE SCHEDULE';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    return query
    select sa.id, sa.user_id, u.full_name, sa.shift_date, sa.start_time, sa.end_time, sa.status, sa.notes, sa.cancelled_reason
    from shift_assignments sa
    join users u on u.id = sa.user_id
    where sa.organization_id = v_org and sa.site_id = p_site_id
      and sa.shift_date between p_start_date and p_end_date
    order by sa.shift_date asc, sa.start_time asc;
end;
$function$;

revoke execute on function public.create_prosm_time_shift_template(uuid, text, time, time, text) from public, anon;
revoke execute on function public.delete_prosm_time_shift_template(uuid) from public, anon;
revoke execute on function public.assign_prosm_time_shift(uuid, uuid, date, time, time, uuid, text) from public, anon;
revoke execute on function public.cancel_prosm_time_shift_assignment(uuid, text) from public, anon;
revoke execute on function public.list_prosm_time_site_shifts(uuid, date, date) from public, anon;

commit;
