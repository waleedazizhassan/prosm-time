-- PROSM Time - SOS on every shift (owner decision 2026-10-13: "the
-- emergency button isn't showing any more" -> option (a)).
--
-- Until now SOS was only reachable during an active presence session,
-- which only exists when the site's presence_monitoring_enabled policy
-- is on - every site created with the default (off) had no emergency
-- button at all. An emergency action must not depend on a monitoring
-- setting, so:
--
--   1. sos_alerts.presence_session_id becomes optional, and every alert
--      now carries the shift it was raised from (attendance_session_id)
--      plus the site it happened at (site_id and a site_name snapshot,
--      so the Emergency Log always names the site even for a reader the
--      presence_sessions/sites RLS would otherwise hide it from - audit
--      item 4.5, "always show the site name in an emergency").
--   2. A BEFORE INSERT trigger fills those columns for both entry
--      points, so the existing trigger_prosm_time_sos_alert (presence
--      path) is left exactly as it is.
--   3. New trigger_prosm_time_shift_sos_alert(p_attendance_session_id)
--      - same checks, audit row and notifications as the presence path,
--      gated on the caller's own clocked-in shift instead.

begin;

alter table public.sos_alerts
    alter column presence_session_id drop not null,
    add column if not exists attendance_session_id uuid references public.attendance_sessions(id) on delete set null,
    add column if not exists site_id uuid references public.sites(id) on delete set null,
    add column if not exists site_name text;

create index if not exists sos_alerts_attendance_session_id_idx on public.sos_alerts(attendance_session_id);

create or replace function public.fill_prosm_time_sos_alert_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if new.attendance_session_id is null and new.presence_session_id is not null then
        select attendance_session_id into new.attendance_session_id
        from presence_sessions where id = new.presence_session_id;
    end if;

    if new.site_id is null and new.attendance_session_id is not null then
        select site_id into new.site_id from attendance_sessions where id = new.attendance_session_id;
    end if;
    if new.site_id is null and new.presence_session_id is not null then
        select site_id into new.site_id from presence_sessions where id = new.presence_session_id;
    end if;

    if new.site_name is null then
        if new.site_id is not null then
            select name into new.site_name from sites where id = new.site_id;
        elsif new.attendance_session_id is not null then
            select manual_location_label into new.site_name from attendance_sessions where id = new.attendance_session_id;
        end if;
    end if;

    return new;
end;
$function$;

revoke execute on function public.fill_prosm_time_sos_alert_context() from public, anon, authenticated;

drop trigger if exists sos_alerts_fill_context on public.sos_alerts;
create trigger sos_alerts_fill_context
before insert on public.sos_alerts
for each row execute function public.fill_prosm_time_sos_alert_context();

-- Backfill existing alerts from their presence session.
update public.sos_alerts a
set attendance_session_id = coalesce(a.attendance_session_id, ps.attendance_session_id),
    site_id = coalesce(a.site_id, ps.site_id)
from public.presence_sessions ps
where ps.id = a.presence_session_id
  and (a.attendance_session_id is null or a.site_id is null);

update public.sos_alerts a
set site_name = s.name
from public.sites s
where s.id = a.site_id
  and a.site_name is null;

create or replace function public.trigger_prosm_time_shift_sos_alert(
    p_attendance_session_id uuid,
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
    v_session attendance_sessions%rowtype;
    v_presence_session_id uuid;
    v_alert_id uuid;
    v_caller_name text;
    v_site_name text;
    v_coworker record;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null or v_caller_org is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from attendance_sessions where id = p_attendance_session_id;
    if v_session.id is null then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id or v_session.organization_id <> v_caller_org then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS SESSION';
    end if;

    if v_session.status <> 'clocked_in' then
        raise exception 'SOS REQUIRES AN ACTIVE SHIFT';
    end if;

    -- Keep the link to presence monitoring when the shift has it.
    select id into v_presence_session_id
    from presence_sessions
    where attendance_session_id = v_session.id and user_id = v_caller_id and status = 'active'
    limit 1;

    insert into sos_alerts (organization_id, user_id, presence_session_id, attendance_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, v_presence_session_id, v_session.id, p_latitude, p_longitude, p_accuracy_meters)
    returning id, site_name into v_alert_id, v_site_name;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active shift.',
        jsonb_build_object('attendanceSessionId', v_session.id, 'presenceSessionId', v_presence_session_id)
    );

    select full_name into v_caller_name from users where id = v_caller_id;

    perform public.notify_prosm_time_supervisors(
        v_caller_org, 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
    );

    -- Same co-worker broadcast as the presence path (20260908170000).
    if v_session.site_id is not null then
        for v_coworker in
            select distinct ats.user_id as id
            from attendance_sessions ats
            join users u on u.id = ats.user_id
            where ats.site_id = v_session.site_id
              and ats.status = 'clocked_in'
              and ats.user_id <> v_caller_id
              and u.organization_id = v_caller_org
              and not (
                  u.is_owner
                  or exists (
                      select 1 from (
                          select p.permission_key
                          from role_default_permissions rdp
                          join permissions p on p.id = rdp.permission_id
                          where rdp.role_id = u.role_id
                          union
                          select p.permission_key
                          from user_permission_overrides upo
                          join permissions p on p.id = upo.permission_id
                          where upo.user_id = u.id and upo.is_granted = true
                          except
                          select p.permission_key
                          from user_permission_overrides upo
                          join permissions p on p.id = upo.permission_id
                          where upo.user_id = u.id and upo.is_granted = false
                      ) effective
                      where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
                  )
              )
        loop
            perform public.create_prosm_time_notification(
                v_caller_org, v_coworker.id, 'sos_alert', 'high', 'SOS/Emergency alert',
                v_caller_name || ' triggered an SOS/Emergency alert at ' || coalesce(v_site_name, 'your site') || '.',
                'sos_alerts', v_alert_id,
                jsonb_build_object('employeeName', v_caller_name, 'siteName', v_site_name)
            );
        end loop;
    end if;

    return jsonb_build_object('success', true, 'alertId', v_alert_id);
exception
    when others then
        raise exception 'TRIGGER PROSM TIME SHIFT SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.trigger_prosm_time_shift_sos_alert(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.trigger_prosm_time_shift_sos_alert(uuid, double precision, double precision, double precision) to authenticated;

commit;
