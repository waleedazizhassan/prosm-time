-- 2026-11-11 (owner): "I tried a fake location from an employee's account a few days ago and nothing
-- reached me as the owner." A clock-in or clock-out with a location Android reports as simulated was
-- only kept for review (mock_location_flags) - nobody was told. Now the owner and whoever reviews
-- attendance get a notification at once (high priority), as during the shift.
-- Rollback: recreate record_prosm_time_mock_location from 20261013180000.

begin;

create or replace function public.record_prosm_time_mock_location(
    p_organization_id uuid,
    p_user_id uuid,
    p_site_id uuid,
    p_attendance_event_id uuid,
    p_event_type text,
    p_latitude double precision,
    p_longitude double precision,
    p_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_id uuid;
    v_name text;
begin
    insert into mock_location_flags (organization_id, user_id, site_id, attendance_event_id, event_type, latitude, longitude, occurred_at)
    values (p_organization_id, p_user_id, p_site_id, p_attendance_event_id, p_event_type, p_latitude, p_longitude, p_occurred_at)
    on conflict (attendance_event_id) do nothing
    returning id into v_id;
    if v_id is not null then
        select full_name into v_name from users where id = p_user_id;
        perform public.notify_prosm_time_supervisors(
            p_organization_id, 'location_plausibility_flag', 'high', 'Fake location',
            coalesce(v_name, '') || ' used a fake (simulated) location to ' || replace(p_event_type, '_', ' ') || '.',
            'mock_location_flags', v_id,
            jsonb_build_object('employeeName', v_name, 'kind', 'mock_location', 'eventType', p_event_type, 'siteId', p_site_id)
        );
    end if;
    return v_id;
end;
$function$;
revoke execute on function public.record_prosm_time_mock_location(uuid, uuid, uuid, uuid, text, double precision, double precision, timestamptz) from public, anon, authenticated;

commit;
