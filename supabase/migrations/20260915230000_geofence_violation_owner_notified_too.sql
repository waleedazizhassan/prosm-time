-- PROSM Time - real root cause found for the user's #3 report
-- (2026-09-15, "تركيز قوي جدا"): "no notifications arrive on geofence
-- exit, not even a reason-required prompt on a mismatched clock-out
-- location." Both symptoms trace to the SAME function:
-- handle_prosm_time_geofence_violation is called from every geofence-
-- checking path in this codebase (self clock-in, self clock-out,
-- kiosk clock-in, presence sampling while clocked in) - but it has had
-- an unconditional early return for the Owner since 20260904120000:
-- "if is_owner then return exceptionCreated:false" - no
-- geofence_exceptions row, no notification, nothing, silently, for
-- that one org member. The account this whole session (and the user's
-- own live testing) uses IS the real Owner (admin@prosm.net) - so
-- every single geofence violation they personally triggered, on any
-- path, was silently dropped. This is the real, reproducible root
-- cause of the reported "no notifications ever" symptom, not a
-- geofence-detection bug.
--
-- Fix: the Owner still gets their own real geofence_exceptions row and
-- 'out_of_zone_employee' notification (so they see it and can provide
-- a reason via ExceptionsCard.tsx, same as any employee) - only the
-- escalation to a "manager above them" is skipped, since an Owner
-- structurally has no one above them in this schema to escalate to.

begin;

create or replace function public.handle_prosm_time_geofence_violation(
    p_organization_id uuid,
    p_user_id uuid,
    p_distance_meters double precision,
    p_attendance_event_id uuid default null,
    p_presence_session_id uuid default null,
    p_site_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_is_owner boolean;
    v_is_supervisor boolean;
    v_exception_id uuid;
    v_subject_name text;
    v_recipient record;
begin
    select is_owner into v_is_owner from users where id = p_user_id;

    insert into geofence_exceptions (organization_id, user_id, attendance_event_id, presence_session_id, distance_meters, status)
    values (p_organization_id, p_user_id, p_attendance_event_id, p_presence_session_id, p_distance_meters, 'pending_reason')
    returning id into v_exception_id;

    select full_name into v_subject_name from users where id = p_user_id;

    perform public.create_prosm_time_notification(
        p_organization_id, p_user_id, 'out_of_zone_employee', 'normal',
        'You are outside your assigned work area',
        'Please explain why. Distance: ' || round(p_distance_meters::numeric) || ' m.',
        'geofence_exceptions', v_exception_id,
        jsonb_build_object('distanceMeters', round(p_distance_meters::numeric))
    );

    -- § fix, 2026-09-15 - the Owner has no one above them to escalate
    -- to (there is no concept of a second Owner/manager over an Owner
    -- in this schema) - they've already been notified themselves
    -- above, so there's nothing further to do here for that case.
    if coalesce(v_is_owner, false) then
        return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
    end if;

    v_is_supervisor := exists (
        select 1 from (
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
        where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
    );

    if v_is_supervisor then
        for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
        loop
            perform public.create_prosm_time_notification(
                p_organization_id, v_recipient.id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
                v_subject_name || ' is outside the assigned area.', 'geofence_exceptions', v_exception_id,
                jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
            );
        end loop;
    else
        perform public.notify_prosm_time_site_managers_or_owner(
            p_organization_id, p_site_id, 'out_of_zone_manager', 'normal', 'Employee outside their work area',
            v_subject_name || ' is outside the assigned area.',
            'geofence_exceptions', v_exception_id,
            jsonb_build_object('employeeName', v_subject_name, 'distanceMeters', round(p_distance_meters::numeric))
        );
    end if;

    return jsonb_build_object('exceptionCreated', true, 'exceptionId', v_exception_id);
exception
    when others then
        raise exception 'HANDLE PROSM TIME GEOFENCE VIOLATION FAILED: %', sqlerrm;
end;
$function$;

commit;
