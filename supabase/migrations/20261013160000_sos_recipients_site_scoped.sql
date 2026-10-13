-- Audit 2026-10-12, item 4.5 - managers and supervisors saw (and were
-- notified of) SOS alerts from sites they don't manage, because every
-- holder of attendance.view / exceptions.manage in the organisation was
-- included. Recipients are now (owner decision in the audit):
--   * the site's own managers (role_at_site = 'manager'),
--   * the Owner, always (and alone for an alert with no site),
--   * co-workers clocked in at the same site, as before.
-- The Emergency Log follows the same reach: the person themself, the
-- Owner, attendance.view holders for the sites they manage, and the
-- read-only role (whole organisation). The site name is stored on every
-- alert since 20261013100000, so it always shows.

begin;

drop policy if exists "sos alerts visible to subject or attendance.view" on public.sos_alerts;
create policy "sos alerts visible to subject or attendance.view"
on public.sos_alerts for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                and (site_id = any(public.current_prosm_time_managed_site_ids()) or public.current_prosm_time_user_role_key() = 'read_only')
            )
        )
    )
);

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

    -- Audit 4.5: the site's own managers plus the Owner (no site: the Owner).
    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, v_session.site_id, 'sos_alert', 'high', 'SOS/Emergency alert',
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
              -- already told above as the site's manager or the Owner
              and not u.is_owner
              and not exists (
                  select 1 from site_assignments sa
                  where sa.site_id = v_session.site_id and sa.user_id = u.id and sa.role_at_site = 'manager'
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

create or replace function public.trigger_prosm_time_sos_alert(
    p_presence_session_id uuid,
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
    v_session presence_sessions%rowtype;
    v_alert_id uuid;
    v_caller_name text;
    v_site_name text;
    v_coworker record;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_session from presence_sessions where id = p_presence_session_id;
    if v_session.id is null then
        raise exception 'PRESENCE SESSION NOT FOUND';
    end if;

    if v_session.user_id <> v_caller_id then
        raise exception 'YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION';
    end if;

    if v_session.status <> 'active' then
        raise exception 'SOS REQUIRES AN ACTIVE PRESENCE SESSION';
    end if;

    insert into sos_alerts (organization_id, user_id, presence_session_id, latitude, longitude, accuracy_meters)
    values (v_caller_org, v_caller_id, p_presence_session_id, p_latitude, p_longitude, p_accuracy_meters)
    returning id into v_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_caller_org, v_caller_id, v_caller_id, 'SOS_ALERT_TRIGGERED', 'sos_alerts', v_alert_id,
        'SOS/Emergency action triggered during an active presence session.',
        jsonb_build_object('presenceSessionId', p_presence_session_id)
    );

    select full_name into v_caller_name from users where id = v_caller_id;

    -- Audit 4.5: the site's own managers plus the Owner (no site: the Owner).
    perform public.notify_prosm_time_site_managers_or_owner(
        v_caller_org, v_session.site_id, 'sos_alert', 'high', 'SOS/Emergency alert',
        v_caller_name || ' triggered an SOS/Emergency alert.', 'sos_alerts', v_alert_id,
        jsonb_build_object('employeeName', v_caller_name)
    );

    if v_session.site_id is not null then
        select name into v_site_name from sites where id = v_session.site_id;

        for v_coworker in
            select distinct ats.user_id as id
            from attendance_sessions ats
            join users u on u.id = ats.user_id
            where ats.site_id = v_session.site_id
              and ats.status = 'clocked_in'
              and ats.user_id <> v_caller_id
              and u.organization_id = v_caller_org
              -- already told above as the site's manager or the Owner
              and not u.is_owner
              and not exists (
                  select 1 from site_assignments sa
                  where sa.site_id = v_session.site_id and sa.user_id = u.id and sa.role_at_site = 'manager'
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
        raise exception 'TRIGGER PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

commit;
