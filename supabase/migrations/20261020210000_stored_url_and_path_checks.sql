-- Security review L2/L3, owner 2026-10-20.
-- L2. A clock-in photo record could point at any file in the bucket - not
--     only the folder of its own clock-in - and the photo clean-up later
--     deletes what the record points at. The path must now be inside the
--     event's own folder.
-- L3. The organisation logo and a person's avatar accepted any text, so
--     they could point at an outside address (a tracking image) or carry
--     markup into the printed reports. They must now be a file in this
--     project's own logo / avatar storage (or empty, to remove it).
-- Same front-door pattern as 20261020190000.

begin;

alter function public.attach_prosm_time_camera_evidence(uuid, text, text, integer) rename to attach_prosm_time_camera_evidence_unchecked;
alter function public.set_prosm_time_organization_logo(text) rename to set_prosm_time_organization_logo_unchecked;
alter function public.set_prosm_time_own_avatar(text) rename to set_prosm_time_own_avatar_unchecked;
revoke all on function public.attach_prosm_time_camera_evidence_unchecked(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.set_prosm_time_organization_logo_unchecked(text) from public, anon, authenticated;
revoke all on function public.set_prosm_time_own_avatar_unchecked(text) from public, anon, authenticated;

create function public.attach_prosm_time_camera_evidence(
    p_attendance_event_id uuid,
    p_storage_path text,
    p_content_type text,
    p_file_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if p_storage_path is null
       or p_storage_path !~ ('^attendance-events/' || p_attendance_event_id::text || '/[A-Za-z0-9._-]+$') then
        raise exception 'ATTACH CAMERA EVIDENCE FAILED: THE PHOTO MUST BE IN ITS OWN CLOCK-IN FOLDER';
    end if;
    return public.attach_prosm_time_camera_evidence_unchecked(p_attendance_event_id, p_storage_path, p_content_type, p_file_size_bytes);
end;
$function$;

create or replace function public.prosm_time_is_own_storage_url(p_url text, p_bucket text)
returns boolean
language sql
immutable
set search_path = public
as $function$
    select p_url ~ ('^https://[A-Za-z0-9.-]+/storage/v1/object/public/' || p_bucket || '/[A-Za-z0-9/._-]+$');
$function$;

create function public.set_prosm_time_organization_logo(p_logo_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if nullif(trim(coalesce(p_logo_url, '')), '') is not null and not public.prosm_time_is_own_storage_url(p_logo_url, 'organization-logos') then
        raise exception 'SET PROSM TIME ORGANIZATION LOGO FAILED: THE LOGO MUST BE AN UPLOADED IMAGE';
    end if;
    return public.set_prosm_time_organization_logo_unchecked(nullif(trim(coalesce(p_logo_url, '')), ''));
end;
$function$;

create function public.set_prosm_time_own_avatar(p_avatar_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if nullif(trim(coalesce(p_avatar_url, '')), '') is not null and not public.prosm_time_is_own_storage_url(p_avatar_url, 'user-avatars') then
        raise exception 'SET PROSM TIME OWN AVATAR FAILED: THE PICTURE MUST BE AN UPLOADED IMAGE';
    end if;
    return public.set_prosm_time_own_avatar_unchecked(nullif(trim(coalesce(p_avatar_url, '')), ''));
end;
$function$;

revoke all on function public.attach_prosm_time_camera_evidence(uuid, text, text, integer) from public, anon;
revoke all on function public.set_prosm_time_organization_logo(text) from public, anon;
revoke all on function public.set_prosm_time_own_avatar(text) from public, anon;
grant execute on function public.attach_prosm_time_camera_evidence(uuid, text, text, integer) to authenticated;
grant execute on function public.set_prosm_time_organization_logo(text) to authenticated;
grant execute on function public.set_prosm_time_own_avatar(text) to authenticated;

commit;
