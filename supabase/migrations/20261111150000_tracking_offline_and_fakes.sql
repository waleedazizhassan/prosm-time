-- 2026-11-11 (owner): "remember there is offline recording - so the server does not stop it, and no
-- fake recording." The phone's shift service keeps the locations it could not send (no network) and
-- sends them later with the time each was taken; it also says when Android reports a location as
-- simulated. Here:
--   * a location taken more than 3 minutes before it arrives is kept as history only - it never
--     raises "left the site", an exception or an "impossible speed" flag after the fact; one taken
--     more than 24 hours ago, or in the future, is not taken at all;
--   * a simulated (fake) location is never recorded; the managers are told once per shift;
--   * "no shift" is still answered when the server has none - the phone decides (an offline clock-in
--     not sent yet is not a reason to stop).
-- Rollback: recreate record_prosm_time_location_by_key from 20261111140000; drop the column
-- presence_sessions.mock_flagged_at.

begin;

alter table public.presence_sessions add column if not exists mock_flagged_at timestamptz;

drop function if exists public.record_prosm_time_location_by_key(text, double precision, double precision, double precision, timestamptz);

create or replace function public.record_prosm_time_location_by_key(
    p_key text,
    p_latitude double precision,
    p_longitude double precision,
    p_accuracy double precision default null,
    p_at timestamptz default null,
    p_simulated boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key tracking_keys%rowtype;
    v_auth uuid;
    v_presence presence_sessions%rowtype;
    v_at timestamptz := coalesce(p_at, now());
    v_name text;
    v_result jsonb;
begin
    if p_key is null or length(p_key) < 32 then return jsonb_build_object('active', false, 'reason', 'key'); end if;
    select * into v_key from tracking_keys where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') and expires_at > now();
    if v_key.id is null then return jsonb_build_object('active', false, 'reason', 'key'); end if;
    select auth_user_id, full_name into v_auth, v_name from users where id = v_key.user_id and is_active;
    if v_auth is null then return jsonb_build_object('active', false, 'reason', 'user'); end if;
    if p_latitude is null or p_longitude is null then return jsonb_build_object('active', true, 'skipped', 'no_location'); end if;

    select p.* into v_presence
    from presence_sessions p
    join attendance_sessions a on a.id = p.attendance_session_id
    where p.user_id = v_key.user_id and p.status = 'active' and a.status = 'clocked_in'
    order by p.started_at desc limit 1;
    if v_presence.id is null then return jsonb_build_object('active', false, 'reason', 'no_shift'); end if;
    update tracking_keys set last_used_at = now() where id = v_key.id;

    -- a time from the future is the phone's clock: now; one older than a day is not taken
    if v_at > now() then v_at := now(); end if;
    if v_at < now() - interval '24 hours' or v_at < v_presence.started_at - interval '5 minutes' then
        return jsonb_build_object('active', true, 'skipped', 'old');
    end if;

    -- a fake location is never recorded; the managers hear once per shift
    if coalesce(p_simulated, false) then
        if v_presence.mock_flagged_at is null then
            update presence_sessions set mock_flagged_at = now() where id = v_presence.id;
            perform public.notify_prosm_time_supervisors(
                v_presence.organization_id, 'location_plausibility_flag', 'high', 'Fake location during a shift',
                coalesce(v_name, '') || ' used a fake (simulated) location during the shift.',
                'presence_sessions', v_presence.id,
                jsonb_build_object('employeeName', v_name, 'kind', 'mock_presence')
            );
        end if;
        return jsonb_build_object('active', true, 'rejected', 'simulated');
    end if;

    -- a location sent late (kept on the phone while offline) is history: no exit, no exception, no flag
    if v_at < now() - interval '3 minutes' then
        insert into location_samples (presence_session_id, user_id, latitude, longitude, accuracy_meters, client_reported_at)
        values (v_presence.id, v_key.user_id, p_latitude, p_longitude, p_accuracy, v_at);
        return jsonb_build_object('active', true, 'stored', 'history');
    end if;

    -- a fresh location: the same path as one sent by the app, as this person
    perform set_config('request.jwt.claim.sub', v_auth::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    v_result := public.record_prosm_time_presence_sample(v_presence.id, p_latitude, p_longitude, p_accuracy, v_at);
    return coalesce(v_result, '{}'::jsonb) || jsonb_build_object('active', true);
end;
$$;
revoke all on function public.record_prosm_time_location_by_key(text, double precision, double precision, double precision, timestamptz, boolean) from public;
grant execute on function public.record_prosm_time_location_by_key(text, double precision, double precision, double precision, timestamptz, boolean) to anon, authenticated;

commit;
