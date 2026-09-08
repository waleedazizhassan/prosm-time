-- PROSM Time - real limitation found live: tried creating a "Night"
-- template (22:00-06:00, a genuinely common real shift pattern) and it
-- was rejected - shift_templates/shift_assignments store start_time/
-- end_time as plain `time` (no date component), and this schema's own
-- overlap-detection query (a same-day, non-wrapping time-range compare)
-- would give WRONG answers for a shift that crosses midnight without a
-- real redesign (proper overnight support needs actual timestamptz
-- arithmetic, not bare `time` comparisons - genuinely more scope than
-- this pass). Rather than silently fail with a bare "END TIME MUST BE
-- AFTER START TIME" that doesn't explain why, or pretend to support
-- something not actually built, the error now says exactly what the
-- real limitation is and the real workaround (split into two same-day
-- shifts) - matching this session's own "no placeholders, honest
-- claims" standard rather than a silent gap.

begin;

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
        raise exception 'END TIME MUST BE AFTER START TIME - OVERNIGHT SHIFTS CROSSING MIDNIGHT ARE NOT SUPPORTED YET, SPLIT INTO TWO SAME-DAY SHIFTS INSTEAD (E.G. 22:00-23:59 AND 00:00-06:00)';
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
        raise exception 'END TIME MUST BE AFTER START TIME - OVERNIGHT SHIFTS CROSSING MIDNIGHT ARE NOT SUPPORTED YET, SPLIT INTO TWO SAME-DAY SHIFTS INSTEAD (E.G. 22:00-23:59 AND 00:00-06:00)';
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

commit;
