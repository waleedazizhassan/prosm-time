-- Owner 2026-11-03 (nine languages), follow-up:
-- 1. A person's email language: their choice in the app, else their phone's, else Arabic -
--    as every email was before. organization_settings.default_language is 'en' for every
--    organisation by the column's default (nobody ever chose it), so it is not a choice to
--    follow: with it, an Arabic reader who has not opened the new app yet would get English.
-- 2. prosm_time_languages() is not for anonymous callers.

create or replace function public.prosm_time_user_language(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select u.preferred_language from users u where u.id = p_user and u.preferred_language = any (public.prosm_time_languages())),
        (select d.language from push_devices d where d.user_id = p_user and d.language = any (public.prosm_time_languages()) order by d.last_seen_at desc limit 1),
        'ar');
$$;
revoke all on function public.prosm_time_user_language(uuid) from public, anon, authenticated;
grant execute on function public.prosm_time_user_language(uuid) to service_role;

create or replace function public.prosm_time_language_for_email(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select public.prosm_time_user_language(u.id) from users u where lower(u.email) = lower(trim(p_email)) order by u.is_active desc limit 1), 'ar');
$$;
revoke all on function public.prosm_time_language_for_email(text) from public, anon, authenticated;
grant execute on function public.prosm_time_language_for_email(text) to service_role;

revoke all on function public.prosm_time_languages() from public, anon;
grant execute on function public.prosm_time_languages() to authenticated, service_role;
