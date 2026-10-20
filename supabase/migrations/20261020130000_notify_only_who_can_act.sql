-- Owner 2026-10-20 (review of where reasons and exceptions go): a
-- notification now goes only to the people who can act on it - the Owner,
-- and the managers of the person's site who rank above them; never the
-- person themselves. Before, an employee's reason for being outside the
-- work area reached every manager and supervisor in the organisation, and
-- a manager's own exception notified that manager and their peers - none of
-- whom could decide it (20261019110000).

begin;

CREATE OR REPLACE FUNCTION public.notify_prosm_time_managers_of_subject_or_owner(p_organization_id uuid, p_subject_user_id uuid, p_type text, p_priority text, p_title text, p_body text, p_related_entity_type text DEFAULT NULL::text, p_related_entity_id uuid DEFAULT NULL::uuid, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_recipient record;
begin
    for v_recipient in
        select distinct u.id
        from users u
        join site_assignments sa on sa.user_id = u.id
        where u.organization_id = p_organization_id
        and sa.role_at_site = 'manager'
        and sa.site_id in (select site_id from site_assignments where user_id = p_subject_user_id)
        -- only those who can act on it: above the person, never the person themselves
        and u.id <> p_subject_user_id
        and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_subject_user_id)
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;

    -- The Owner always sees this too - both as the no-site fallback
    -- and as the standing escalation on top of that employee's own
    -- site manager(s). create_prosm_time_notification's own 15-minute
    -- dedup already makes a double-call harmless if the Owner also
    -- happens to be one of the site's own assigned managers.
    for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_prosm_time_supervisors(p_organization_id uuid, p_type text, p_priority text, p_title text, p_body text, p_related_entity_type text DEFAULT NULL::text, p_related_entity_id uuid DEFAULT NULL::uuid, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_recipient record;
    v_subject uuid;
    v_site uuid;
begin
    -- Owner 2026-10-20: the person and the site the item is about, so only the
    -- people who can act on it are told (it went to every manager and
    -- supervisor of the whole organisation).
    if p_related_entity_type = 'geofence_exceptions' then
        select ge.user_id, coalesce(
            (select coalesce(ats.site_id, ats.responsible_site_id) from attendance_events ae join attendance_sessions ats on ats.id = ae.session_id where ae.id = ge.attendance_event_id),
            (select coalesce(ps.site_id, ats.site_id, ats.responsible_site_id) from presence_sessions ps left join attendance_sessions ats on ats.id = ps.attendance_session_id where ps.id = ge.presence_session_id)
        )
        into v_subject, v_site
        from geofence_exceptions ge where ge.id = p_related_entity_id;
    elsif p_related_entity_type = 'attendance_sessions' then
        select s.user_id, coalesce(s.site_id, s.responsible_site_id) into v_subject, v_site
        from attendance_sessions s where s.id = p_related_entity_id;
    end if;

    for v_recipient in
        select u.id
        from users u
        where u.organization_id = p_organization_id
          and u.is_active
          and (
              u.is_owner
              or (
                  v_subject is not null
                  and u.id <> v_subject
                  and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_subject)
                  and public.prosm_time_user_has_permission_internal(u.id, 'exceptions.manage')
                  and exists (
                      select 1 from site_assignments sa
                      where sa.user_id = u.id and sa.role_at_site = 'manager'
                        and (
                            sa.site_id = v_site
                            or (v_site is null and sa.site_id in (select site_id from site_assignments where user_id = v_subject))
                        )
                  )
              )
              -- an item we can't place (no person found): as before, everyone who reviews
              or (v_subject is null and public.prosm_time_user_has_permission_internal(u.id, 'exceptions.manage'))
          )
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

commit;
