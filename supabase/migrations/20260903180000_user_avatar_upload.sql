-- PROSM Time - § live UX review, user-directed: "I want a place in
-- the user menu to upload a profile picture." Mirrors the existing
-- organization-logo upload exactly (20260901190000_org_logo_upload.sql)
-- - one nullable column, one public storage bucket (a profile picture
-- is meant to be seen by teammates, not access-controlled like camera
-- evidence), one self-service RPC. Unlike the logo (Owner-only), any
-- user sets their OWN avatar - no authority check beyond "is this your
-- own row."

begin;

alter table public.users add column avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-avatars', 'user-avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: users/{user_id}/{filename} - only that user may
-- write into their own folder.
create policy "user can upload own avatar"
on storage.objects for insert to authenticated
with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text
);

create policy "user can replace own avatar"
on storage.objects for update to authenticated
using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = public.current_prosm_time_user_id()::text
);

create or replace function public.set_prosm_time_own_avatar(p_avatar_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    update users set avatar_url = p_avatar_url, updated_at = now() where id = v_caller_id;

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME OWN AVATAR FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.set_prosm_time_own_avatar(text) from public, anon;
grant execute on function public.set_prosm_time_own_avatar(text) to authenticated;

commit;
