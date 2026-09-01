-- PROSM Time - § live UX review, user-directed: "I want a place to
-- upload the company logo [during activation] so it shows in the
-- organization data in the Header." A real, small feature addition -
-- one nullable column, one public storage bucket (a company logo is
-- meant to be seen, not access-controlled like camera evidence), and
-- one owner-only RPC to set it, matching this codebase's own
-- established posture: every organizations mutation goes through a
-- SECURITY DEFINER RPC, never a direct client UPDATE grant (there is
-- no UPDATE policy on organizations at all today).

begin;

alter table public.organizations add column logo_url text;

-- Public bucket (unlike camera-evidence's private one) - a logo is
-- meant to render for every org member via a plain public URL, no
-- signed-URL round trip needed, same posture as the app's own static
-- brand asset.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('organization-logos', 'organization-logos', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: organizations/{organization_id}/{filename} - only
-- the org's own Owner may write into their own folder.
create policy "owner can upload own organization logo"
on storage.objects for insert to authenticated
with check (
    bucket_id = 'organization-logos'
    and (storage.foldername(name))[1] = 'organizations'
    and (storage.foldername(name))[2] = public.current_prosm_time_organization_id()::text
    and public.current_prosm_time_user_is_owner()
);

create policy "owner can replace own organization logo"
on storage.objects for update to authenticated
using (
    bucket_id = 'organization-logos'
    and (storage.foldername(name))[1] = 'organizations'
    and (storage.foldername(name))[2] = public.current_prosm_time_organization_id()::text
    and public.current_prosm_time_user_is_owner()
);

create or replace function public.set_prosm_time_organization_logo(p_logo_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not public.current_prosm_time_user_is_owner() then
        raise exception 'ONLY THE ORGANIZATION OWNER MAY SET THE LOGO';
    end if;

    v_org_id := public.current_prosm_time_organization_id();
    if v_org_id is null then
        raise exception 'NO ORGANIZATION FOR THIS SESSION';
    end if;

    update organizations set logo_url = p_logo_url, updated_at = now() where id = v_org_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_org_id, v_caller_id, v_caller_id, 'ORGANIZATION_LOGO_UPDATED', 'organizations', v_org_id,
        'Organization logo updated.',
        jsonb_build_object('logoUrl', p_logo_url)
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SET PROSM TIME ORGANIZATION LOGO FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.set_prosm_time_organization_logo(text) from public, anon;
grant execute on function public.set_prosm_time_organization_logo(text) to authenticated;

commit;
