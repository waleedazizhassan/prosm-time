-- Workflow audit I4, owner 2026-10-20 ("only the people who can act on it").
-- notify_prosm_time_site_managers_or_owner (time outside the area, missing
-- clock-out, site changes, implausible locations, correction requests, SOS)
-- told every manager of the site - deactivated accounts included, and the
-- manager the notice was about. It now tells only active people, never the
-- person it is about, and - except for an SOS, where every manager of the
-- site should come running - only those ranked above that person.
-- notify_prosm_time_managers_of_subject_or_owner skips deactivated accounts too.

begin;

-- Who a notification is about, from the record it points at.
create or replace function public.prosm_time_notification_subject(p_related_entity_type text, p_related_entity_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_subject uuid;
begin
    if p_related_entity_id is null or p_related_entity_type is null then return null; end if;
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = p_related_entity_type and column_name = 'user_id'
    ) then
        return null;
    end if;
    execute format('select user_id from public.%I where id = $1', p_related_entity_type) into v_subject using p_related_entity_id;
    return v_subject;
end;
$function$;

revoke all on function public.prosm_time_notification_subject(text, uuid) from public, anon, authenticated;

create or replace function public.notify_prosm_time_site_managers_or_owner(
    p_organization_id uuid,
    p_site_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null,
    p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_recipient record;
    v_subject uuid := public.prosm_time_notification_subject(p_related_entity_type, p_related_entity_id);
begin
    if p_site_id is not null then
        for v_recipient in
            select distinct u.id
            from users u
            join site_assignments sa on sa.user_id = u.id
            where u.organization_id = p_organization_id
            and u.is_active
            and sa.site_id = p_site_id
            and sa.role_at_site = 'manager'
            and (v_subject is null or u.id <> v_subject)
            and (
                v_subject is null
                or p_type = 'sos_alert'
                or public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(v_subject)
            )
        loop
            perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
        end loop;
    end if;

    -- The Owner always sees this too (no site: only the Owner).
    for v_recipient in
        select u.id from users u
        where u.organization_id = p_organization_id and u.is_owner and u.is_active
          and (v_subject is null or u.id <> v_subject)
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke all on function public.notify_prosm_time_site_managers_or_owner(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.notify_prosm_time_managers_of_subject_or_owner(p_organization_id uuid, p_subject_user_id uuid, p_type text, p_priority text, p_title text, p_body text, p_related_entity_type text default null, p_related_entity_id uuid default null, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_recipient record;
begin
    for v_recipient in
        select distinct u.id
        from users u
        join site_assignments sa on sa.user_id = u.id
        where u.organization_id = p_organization_id
        and u.is_active
        and sa.role_at_site = 'manager'
        and sa.site_id in (select site_id from site_assignments where user_id = p_subject_user_id)
        -- only those who can act on it: above the person, never the person themselves
        and u.id <> p_subject_user_id
        and public.prosm_time_role_rank(u.id) > public.prosm_time_role_rank(p_subject_user_id)
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;

    for v_recipient in select u.id from users u where u.organization_id = p_organization_id and u.is_owner and u.is_active
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_recipient.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke all on function public.notify_prosm_time_managers_of_subject_or_owner(uuid, uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

commit;
