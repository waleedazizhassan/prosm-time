-- PROSM Time - Mid-Shift Geofence Exit Alert. WP-10 (presence
-- monitoring, 20260831210000) already samples an employee's location
-- every few minutes while clocked in, but its own header comment is
-- explicit it "never evaluates them against a geofence or raises any
-- exception/notification" - that consequence logic belongs to WP-11's
-- own out-of-zone workflow (20260831220000), which today only ever
-- runs at the instant of Clock In/Clock Out. This closes that gap:
-- record_prosm_time_presence_sample now also runs the same
-- authoritative geofence check every other capture point already uses
-- (compute_prosm_time_geofence_check, 20260831200000) and, on a real
-- mid-shift exit, opens the exact same geofence_exceptions row the
-- employee already knows how to resolve (ExceptionsCard.tsx,
-- submit_prosm_time_exception_reason) - no new table, no new review
-- workflow, no new permission.

-- ============================================================
-- 1. geofence_exceptions can now originate from a presence sample,
--    not only a clock-in/out event. Same "exactly one source" shape
--    exception_actions already uses one migration later in this same
--    file for its own two-FK choice.
-- ============================================================

alter table public.geofence_exceptions
    alter column attendance_event_id drop not null,
    add column presence_session_id uuid references public.presence_sessions(id) on delete cascade;

alter table public.geofence_exceptions
    add constraint geofence_exceptions_exactly_one_source check (
        (attendance_event_id is not null and presence_session_id is null)
        or (attendance_event_id is null and presence_session_id is not null)
    );

-- ============================================================
-- 2. record_prosm_time_presence_sample - same signature (WP-10), body
--    now also evaluates the sample against the site's geofence and
--    opens (at most) one unresolved exception per continuous exit,
--    instead of one every sampling interval.
-- ============================================================

create or replace function public.record_prosm_time_presence_sample(
    p_presence_session_id uuid,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy_meters double precision default null,
    p_client_reported_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_session presence_sessions%rowtype;
    v_sample_id uuid;
    v_geofence jsonb;
    v_exception_created boolean := false;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_latitude is null or p_longitude is null then
        raise exception 'LATITUDE AND LONGITUDE ARE REQUIRED';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'THIS PRESENCE SESSION IS NOT ACTIVE';
    end if;

    insert into location_samples (presence_session_id, user_id, latitude, longitude, accuracy_meters, client_reported_at)
    values (p_presence_session_id, v_caller_id, p_latitude, p_longitude, p_accuracy_meters, p_client_reported_at)
    returning id into v_sample_id;

    v_geofence := public.compute_prosm_time_geofence_check(v_session.site_id, p_latitude, p_longitude, p_accuracy_meters);

    if coalesce((v_geofence->>'checked')::boolean, false) and (v_geofence->>'withinGeofence')::boolean = false then
        if not exists (
            select 1 from geofence_exceptions
            where presence_session_id = p_presence_session_id
            and status in ('pending_reason', 'pending_review')
        ) then
            insert into geofence_exceptions (organization_id, user_id, presence_session_id, distance_meters, status)
            values (v_session.organization_id, v_caller_id, p_presence_session_id, (v_geofence->>'distanceMeters')::double precision, 'pending_reason');
            v_exception_created := true;
        end if;
    end if;

    return jsonb_build_object(
        'success', true, 'sampleId', v_sample_id,
        'geofence', v_geofence, 'exceptionCreated', v_exception_created
    );
exception
    when others then
        raise exception 'RECORD PROSM TIME PRESENCE SAMPLE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.record_prosm_time_presence_sample(uuid, double precision, double precision, double precision, timestamptz) to authenticated;
