-- PROSM Time - real overnight-shift support (user-directed follow-up:
-- "الوردية تبقى شيفت واحد" - a night shift, e.g. 22:00-06:00, must be
-- ONE shift record, not the previous workaround of splitting it into
-- two same-day shifts). Supersedes the deliberate scope-limitation
-- documented in 20260908225000 - that migration's own comment already
-- named the real fix needed ("proper overnight support needs actual
-- timestamptz arithmetic, not bare `time` comparisons"); this is that
-- fix.
--
-- Deliberately does NOT add any new persisted columns/backfill - the
-- table keeps plain `time` start/end (still useful standalone for
-- display and for shift_templates, which has no date at all). Instead,
-- end_time <= start_time now means "ends the next day" by convention,
-- and every place that reasoned about a shift's real span (the range
-- check, the overlap check) is rewritten to add that day explicitly
-- when computing a comparable timestamp, rather than comparing bare
-- `time` values within a single date the way the original, non-
-- overnight-aware version did.

begin;

alter table public.shift_assignments drop constraint shift_assignments_valid_range;
alter table public.shift_assignments add constraint shift_assignments_valid_range check (end_time <> start_time);

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
    if p_end_time = p_start_time then
        raise exception 'END TIME MUST BE DIFFERENT FROM START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
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
    v_new_start timestamp;
    v_new_end timestamp;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('schedules.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'YOU ARE NOT AUTHORIZED TO ASSIGN SHIFTS';
    end if;
    if p_end_time = p_start_time then
        raise exception 'END TIME MUST BE DIFFERENT FROM START TIME';
    end if;

    v_org := public.current_prosm_time_organization_id();
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org) then
        raise exception 'EMPLOYEE NOT FOUND';
    end if;
    if not exists (select 1 from sites where id = p_site_id and organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
    end if;

    -- p_end_time <= p_start_time means this shift crosses midnight and
    -- really ends on p_shift_date + 1. Every overlap comparison below
    -- works in plain local (naive) timestamps - the same "site's own
    -- wall clock" space shift_date/start_time/end_time already implied
    -- before this migration, just made explicit across a day boundary
    -- instead of silently wrapping.
    v_new_start := p_shift_date + p_start_time;
    v_new_end := p_shift_date + p_end_time + (case when p_end_time <= p_start_time then interval '1 day' else interval '0' end);

    -- A true overlap can only ever involve a shift whose OWN date is at
    -- most one day away from p_shift_date (no shift here can span more
    -- than 24h) - checking that 3-day window instead of just
    -- shift_date = p_shift_date is what makes this correct for
    -- overnight shifts on either side of the comparison.
    select exists (
        select 1 from shift_assignments sa
        where sa.user_id = p_user_id and sa.status = 'scheduled'
          and sa.shift_date between p_shift_date - 1 and p_shift_date + 1
          and v_new_start < (sa.shift_date + sa.end_time + (case when sa.end_time <= sa.start_time then interval '1 day' else interval '0' end))
          and v_new_end > (sa.shift_date + sa.start_time)
    ) into v_has_overlap;
    if v_has_overlap then
        raise exception 'THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE';
    end if;

    insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time, notes, created_by)
    values (v_org, p_user_id, p_site_id, p_shift_template_id, p_shift_date, p_start_time, p_end_time, nullif(trim(coalesce(p_notes, '')), ''), v_caller_id)
    returning id into v_assignment_id;

    perform public.create_prosm_time_notification(
        v_org, p_user_id, 'shift_assigned', 'normal', 'A new shift was scheduled for you',
        'You are scheduled on ' || p_shift_date::text || ' from ' || p_start_time::text || ' to ' || p_end_time::text ||
            (case when p_end_time <= p_start_time then ' (next day)' else '' end) || '.',
        'shift_assignments', v_assignment_id,
        jsonb_build_object('shiftDate', p_shift_date, 'startTime', p_start_time, 'endTime', p_end_time, 'crossesMidnight', p_end_time <= p_start_time)
    );

    return jsonb_build_object('success', true, 'assignmentId', v_assignment_id);
exception
    when others then
        raise exception 'ASSIGN PROSM TIME SHIFT FAILED: %', sqlerrm;
end;
$function$;

-- Adds crossesMidnight so the schedule UI can show a clear "+1 day"
-- indicator instead of a start time that looks later than the end
-- time with no explanation. Changing RETURNS TABLE's own column set
-- needs an explicit DROP first - CREATE OR REPLACE cannot change an
-- existing function's return type (the exact pitfall this session's
-- own memory already flags from create_prosm_time_site/is_active_
-- delegate_for - caught here immediately via the same lesson, not
-- rediscovered the hard way).
drop function if exists public.list_prosm_time_site_shifts(uuid, date, date);

create function public.list_prosm_time_site_shifts(
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
    crosses_midnight boolean,
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
    if not exists (select 1 from sites s where s.id = p_site_id and s.organization_id = v_org) then
        raise exception 'SITE NOT FOUND';
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

commit;
