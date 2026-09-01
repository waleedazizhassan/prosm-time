-- PROSM Time - § live UX review, user-directed (explicit product
-- decision, not a UI-only request): "the site in attendance
-- registration should be optional - the important thing is
-- registering attendance at the employee's actual current location,
-- because they may be working somewhere not registered as a work
-- site." A real, deliberate change to WP-06's own domain rule: Clock
-- In no longer requires a site. When one is given, every existing
-- rule (site assignment check, project-at-site check, geofence
-- validation, presence monitoring) is completely unchanged. When none
-- is given, the session is simply recorded against the employee's
-- captured GPS coordinates alone - compute_prosm_time_geofence_check()
-- already returns { checked: false, reason: 'SITE_NOT_FOUND' } for a
-- null site (verified in its own WP-09 definition), so geofencing,
-- Clock Out, and every read path built on attendance_sessions already
-- tolerate a null site_id without further changes.

begin;

alter table public.attendance_sessions alter column site_id drop not null;

-- Reordering p_site_id to carry a default changes the function's own
-- parameter TYPE SEQUENCE (uuid,text,... -> text,uuid,...), which
-- Postgres treats as a distinct overload rather than a replacement -
-- drop the old exact signature explicitly first, matching this
-- project's own "never edit an already-applied migration file, always
-- a follow-up" convention (see the WP-16 ungrouped-column fix).
drop function if exists public.clock_in_prosm_time_attendance(uuid, text, uuid, timestamptz, double precision, double precision, double precision);

create function public.clock_in_prosm_time_attendance(
    p_idempotency_key text,
    p_site_id uuid default null,
    p_project_id uuid default null,
    p_client_reported_at timestamptz default null,
    p_latitude double precision default null,
    p_longitude double precision default null,
    p_accuracy_meters double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_event attendance_events%rowtype;
    v_open_session attendance_sessions%rowtype;
    v_session_id uuid;
    v_event_id uuid;
    v_geofence jsonb;
    v_site sites%rowtype;
    v_presence_session_id uuid;
    v_exception_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
        raise exception 'IDEMPOTENCY KEY IS REQUIRED';
    end if;

    select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
    if v_existing_event.id is not null then
        return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
    end if;

    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_caller_org and is_active = true;
        if v_site.id is null then
            raise exception 'SITE NOT FOUND';
        end if;

        if not exists (select 1 from site_assignments where site_id = p_site_id and user_id = v_caller_id) then
            raise exception 'YOU ARE NOT ASSIGNED TO THIS SITE';
        end if;

        if p_project_id is not null then
            if not exists (select 1 from projects where id = p_project_id and site_id = p_site_id) then
                raise exception 'PROJECT NOT FOUND AT THIS SITE';
            end if;
            if not exists (select 1 from project_assignments where project_id = p_project_id and user_id = v_caller_id) then
                raise exception 'YOU ARE NOT ASSIGNED TO THIS PROJECT';
            end if;
        end if;
    end if;

    select * into v_open_session from attendance_sessions where user_id = v_caller_id and status = 'clocked_in';
    if v_open_session.id is not null then
        raise exception 'YOU ARE ALREADY CLOCKED IN';
    end if;

    v_geofence := public.compute_prosm_time_geofence_check(p_site_id, p_latitude, p_longitude, p_accuracy_meters);

    insert into attendance_sessions (organization_id, user_id, site_id, project_id, status, clock_in_at)
    values (v_caller_org, v_caller_id, p_site_id, case when p_site_id is null then null else p_project_id end, 'clocked_in', now())
    returning id into v_session_id;

    insert into attendance_events (
        session_id, user_id, event_type, occurred_at, client_reported_at,
        latitude, longitude, accuracy_meters, idempotency_key,
        geofence_checked, within_geofence, distance_meters
    ) values (
        v_session_id, v_caller_id, 'clock_in', now(), p_client_reported_at,
        p_latitude, p_longitude, p_accuracy_meters, p_idempotency_key,
        coalesce((v_geofence->>'checked')::boolean, false),
        (v_geofence->>'withinGeofence')::boolean,
        (v_geofence->>'distanceMeters')::double precision
    )
    returning id into v_event_id;

    if (v_geofence->>'checked')::boolean and (v_geofence->>'withinGeofence')::boolean = false then
        insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
        values (v_caller_org, v_caller_id, v_event_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason')
        returning id into v_exception_id;

        perform public.create_prosm_time_notification(
            v_caller_org, v_caller_id, 'out_of_zone_employee', 'normal',
            'You are outside your assigned work area',
            'Please explain why. Distance: ' || round((v_geofence->>'distanceMeters')::numeric) || ' m.',
            'geofence_exceptions', v_exception_id
        );
        perform public.notify_prosm_time_supervisors(
            v_caller_org, 'out_of_zone_manager', 'normal', 'Employee clocked in outside their work area',
            (select full_name from users where id = v_caller_id) || ' clocked in outside the assigned area.',
            'geofence_exceptions', v_exception_id
        );
    end if;

    if v_site.id is not null and v_site.presence_monitoring_enabled then
        insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
        values (v_caller_org, v_session_id, v_caller_id, p_site_id, 'active', now())
        returning id into v_presence_session_id;
    end if;

    return jsonb_build_object(
        'success', true, 'sessionId', v_session_id, 'eventId', v_event_id, 'replay', false,
        'geofence', v_geofence, 'presenceSessionId', v_presence_session_id
    );
exception
    when unique_violation then
        select * into v_existing_event from attendance_events where user_id = v_caller_id and idempotency_key = p_idempotency_key;
        if v_existing_event.id is not null then
            return jsonb_build_object('success', true, 'sessionId', v_existing_event.session_id, 'eventId', v_existing_event.id, 'replay', true);
        end if;
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
    when others then
        raise exception 'CLOCK IN FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision) from public, anon;
grant execute on function public.clock_in_prosm_time_attendance(text, uuid, uuid, timestamptz, double precision, double precision, double precision) to authenticated;

commit;
