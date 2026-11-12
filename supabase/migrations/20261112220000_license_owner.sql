-- Owner 2026-11-12: "at activation the owner also writes their official name, national ID number and mobile;
-- the owner's data is recorded in the licence and shows in Platform Manager, where I can change the owner -
-- email, name and the full data". PROSM Time sends the owner's data with the activation; the licence carries
-- it with a change number; each licence check here applies a newer one to the owner's account (the sign-in
-- email itself is changed by the sync function through the auth service, which also sends the new owner a
-- link to set a password).
-- Rollback: drop functions get_prosm_time_owner_identity(uuid), apply_prosm_time_license_owner(uuid, jsonb);
-- alter table license_activation_state drop column owner_version.

begin;

alter table public.license_activation_state add column if not exists owner_version integer not null default 0;

-- who the owner is now (the sync function decides from this whether the email must change)
create or replace function public.get_prosm_time_owner_identity(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'userId', u.id, 'authUserId', u.auth_user_id, 'email', u.email, 'fullName', u.full_name,
        'ownerVersion', coalesce((select owner_version from license_activation_state where organization_id = p_organization_id), 0))
    from users u
    where u.organization_id = p_organization_id and u.is_owner
    order by u.created_at limit 1;
$$;
revoke all on function public.get_prosm_time_owner_identity(uuid) from public, anon, authenticated;
grant execute on function public.get_prosm_time_owner_identity(uuid) to service_role;

-- the licence's owner data applied to the owner's account (a newer change number only); service role only
create or replace function public.apply_prosm_time_license_owner(p_organization_id uuid, p_owner jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_version integer := coalesce((p_owner ->> 'version')::integer, 0);
    v_current integer;
    v_user users%rowtype;
    v_email text := nullif(lower(btrim(coalesce(p_owner ->> 'email', ''))), '');
    v_name text := nullif(btrim(coalesce(p_owner ->> 'fullName', '')), '');
    v_legal text := nullif(regexp_replace(btrim(coalesce(p_owner ->> 'legalName', '')), '\s+', ' ', 'g'), '');
    v_national text := nullif(btrim(coalesce(p_owner ->> 'nationalId', '')), '');
    v_phone text := nullif(btrim(coalesce(p_owner ->> 'phone', '')), '');
begin
    select owner_version into v_current from license_activation_state where organization_id = p_organization_id;
    if v_current is null then raise exception 'LICENCE NOT FOUND'; end if;
    if v_version <= v_current then return jsonb_build_object('changed', false); end if;
    select * into v_user from users where organization_id = p_organization_id and is_owner order by created_at limit 1;
    if v_user.id is null then raise exception 'OWNER NOT FOUND'; end if;
    if v_email is not null and v_email <> v_user.email
       and exists (select 1 from users where organization_id = p_organization_id and email = v_email and id <> v_user.id) then
        raise exception 'THIS EMAIL BELONGS TO ANOTHER PERSON IN THE ORGANISATION';
    end if;

    update users set
        email = coalesce(v_email, email),
        full_name = coalesce(v_name, full_name),
        legal_name = coalesce(v_legal, legal_name),
        national_id = coalesce(left(v_national, 30), national_id),
        phone = coalesce(left(v_phone, 30), phone),
        updated_at = now()
    where id = v_user.id;
    update license_activation_state set owner_version = v_version where organization_id = p_organization_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (p_organization_id, null, v_user.id, 'license.owner_updated', 'users', v_user.id, 'Owner data changed from PROSM Platform',
            jsonb_build_object('email', v_user.email, 'fullName', v_user.full_name),
            jsonb_build_object('email', coalesce(v_email, v_user.email), 'fullName', coalesce(v_name, v_user.full_name), 'version', v_version));
    return jsonb_build_object('changed', true, 'emailChanged', v_email is not null and v_email <> v_user.email, 'email', coalesce(v_email, v_user.email));
end;
$$;
revoke all on function public.apply_prosm_time_license_owner(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_prosm_time_license_owner(uuid, jsonb) to service_role;

commit;
