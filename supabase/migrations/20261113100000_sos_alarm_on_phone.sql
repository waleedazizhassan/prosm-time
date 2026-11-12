-- Owner 2026-11-12 ("make the SOS ring with the alarm even on silent and open on the whole screen"): the
-- Android app from this version shows an SOS itself (SosMessagingService), so the server must send it to that
-- app as a data message. A phone says it can (set_prosm_time_push_device_alarm, right after registering);
-- older apps keep getting the ordinary notification, which they show without the app.
-- Rollback: drop function set_prosm_time_push_device_alarm(text); restore get_prosm_time_push_message from
-- 20261020110000; alter table push_devices drop column sos_alarm.

begin;

alter table public.push_devices add column if not exists sos_alarm boolean not null default false;

create or replace function public.set_prosm_time_push_device_alarm(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_user uuid := public.current_prosm_time_user_id();
begin
    if v_user is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    update push_devices set sos_alarm = true, last_seen_at = now()
    where token = trim(coalesce(p_token, '')) and user_id = v_user;
    return jsonb_build_object('success', true);
end;
$function$;
revoke all on function public.set_prosm_time_push_device_alarm(text) from public, anon;
grant execute on function public.set_prosm_time_push_device_alarm(text) to authenticated;

-- each phone's own way of taking an SOS goes with its token
do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_push_message(uuid)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def, 'jsonb_build_object(''token'', d.token, ''language'', d.language)',
                            'jsonb_build_object(''token'', d.token, ''language'', d.language, ''sosAlarm'', d.sos_alarm)');
    if v_new = v_def then raise exception 'get_prosm_time_push_message: devices list not found'; end if;
    execute v_new;
end $$;

commit;
