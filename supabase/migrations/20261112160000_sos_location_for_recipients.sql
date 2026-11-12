-- Owner 2026-11-12: "the emergency alarm reaches the employee with 'view the emergency log', though that is the
-- managers' - give it 'show the location' and 'silence'". Whoever received an SOS notification may read
-- that alert's position (and nothing else) to open it on a map; the emergency log stays the managers'.
-- Rollback: drop function get_prosm_time_sos_location(uuid).

begin;

create or replace function public.get_prosm_time_sos_location(p_alert_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_alert sos_alerts%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_alert from sos_alerts where id = p_alert_id and organization_id = public.current_prosm_time_organization_id();
    if v_alert.id is null then raise exception 'ALERT NOT FOUND'; end if;
    -- only someone the alert was sent to
    if not exists (select 1 from notifications n where n.user_id = v_me and n.type = 'sos_alert' and n.related_entity_id = p_alert_id) then
        raise exception 'ALERT NOT FOUND';
    end if;
    return jsonb_build_object('latitude', v_alert.latitude, 'longitude', v_alert.longitude, 'accuracyMeters', v_alert.accuracy_meters);
end;
$$;
revoke all on function public.get_prosm_time_sos_location(uuid) from public, anon;
grant execute on function public.get_prosm_time_sos_location(uuid) to authenticated;

commit;
