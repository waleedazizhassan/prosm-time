-- 2026-11-03 (owner): PROSM Time also in Spanish (es), Brazilian Portuguese (pt), Simplified
-- Chinese (zh) and Russian (ru), across the app, its notifications, its emails and the PDFs
-- they carry. Each person's language is kept on the server (the app writes it when it opens
-- and when it is changed), so an email goes out in the reader's own language.
-- Rollback: drop users.preferred_language, the two functions below, restore the push_devices
-- check and register_prosm_time_push_device / get_prosm_time_leave_email from 20261020110000 /
-- 20261028160000.

begin;

create or replace function public.prosm_time_languages()
returns text[]
language sql
immutable
as $$ select array['ar', 'en', 'fr', 'de', 'it', 'es', 'pt', 'zh', 'ru']::text[] $$;

alter table public.push_devices drop constraint push_devices_language_check;
alter table public.push_devices add constraint push_devices_language_check check (language = any (public.prosm_time_languages()));

alter table public.users add column if not exists preferred_language text
    check (preferred_language is null or preferred_language = any (public.prosm_time_languages()));

create or replace function public.set_prosm_time_my_language(p_language text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_language is null or not (p_language = any (public.prosm_time_languages())) then return; end if;
    update users set preferred_language = p_language where auth_user_id = auth.uid() and preferred_language is distinct from p_language;
end;
$$;
revoke all on function public.set_prosm_time_my_language(text) from public, anon;
grant execute on function public.set_prosm_time_my_language(text) to authenticated;

-- The language to write to a person in: their choice in the app, else their phone's,
-- else their organisation's, else English.
create or replace function public.prosm_time_user_language(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select u.preferred_language from users u where u.id = p_user),
        (select d.language from push_devices d where d.user_id = p_user order by d.last_seen_at desc limit 1),
        (select s.default_language from users u join organization_settings s on s.organization_id = u.organization_id
          where u.id = p_user and s.default_language = any (public.prosm_time_languages())),
        'en');
$$;
revoke all on function public.prosm_time_user_language(uuid) from public, anon, authenticated;
grant execute on function public.prosm_time_user_language(uuid) to service_role;

-- For emails sent with the server's rights to an address (trial notices, password reset):
-- that person's language, else their organisation's, else English.
create or replace function public.prosm_time_language_for_email(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select public.prosm_time_user_language(u.id) from users u where lower(u.email) = lower(trim(p_email)) order by u.is_active desc limit 1), 'en');
$$;
revoke all on function public.prosm_time_language_for_email(text) from public, anon, authenticated;
grant execute on function public.prosm_time_language_for_email(text) to service_role;

-- The phone registers any of the nine languages.
do $$
declare
    v_def text := pg_get_functiondef('public.register_prosm_time_push_device(text, text, text)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def, 'case when p_language in (''ar'', ''en'', ''de'', ''fr'', ''it'') then p_language else ''ar'' end',
                            'case when p_language = any (public.prosm_time_languages()) then p_language else ''ar'' end');
    if v_new = v_def then raise exception 'register_prosm_time_push_device: language list not found'; end if;
    execute v_new;
end $$;

-- Leave emails: each reader's language from the same rule.
do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_leave_email(uuid)'::regprocedure);
    v_new text;
begin
    v_new := replace(v_def, 'coalesce((select d.language from push_devices d where d.user_id = p.id order by d.last_seen_at desc limit 1), ''ar'')',
                            'public.prosm_time_user_language(p.id)');
    if v_new = v_def then raise exception 'get_prosm_time_leave_email: language lookup not found'; end if;
    execute v_new;
end $$;

-- The licence email carries the owner's language.
create or replace function public.get_prosm_time_license_email(p_notification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'organizationId', n.organization_id,
        'to', u.email,
        'name', u.full_name,
        'language', public.prosm_time_user_language(u.id),
        'organizationName', o.name,
        'licenseNumber', l.license_number,
        'status', l.status,
        'plan', coalesce(e.plan, 'legacy'),
        'maxUsers', l.max_users,
        'maxDevices', l.max_devices,
        'activeUsers', (select count(*) from users x where x.organization_id = n.organization_id and x.is_active),
        'expiresAt', l.expires_at,
        'data', n.data,
        'createdAt', n.created_at)
    from notifications n
    join users u on u.id = n.user_id
    join organizations o on o.id = n.organization_id
    join license_activation_state l on l.organization_id = n.organization_id
    left join entitlements e on e.organization_id = n.organization_id
    where n.id = p_notification_id and n.type = 'license_changed' and u.email is not null;
$$;

commit;
