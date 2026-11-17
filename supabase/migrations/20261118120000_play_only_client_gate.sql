-- Owner 2026-11-17: "stop every APK that was ever released - even signed - from talking to the server; only the
-- Google Play (AAB) builds". Old builds cannot be recognised (they send only supabase-js's own x-client-info, like
-- old Play builds), so from this release every build names itself in x-client-info: prosm-time/<play|web|direct>/<version>.
-- PostgREST runs public.prosm_time_client_gate() before every request (pgrst.db_pre_request):
--   * a build that says "direct" (an APK) is refused at once - APP_BUILD_NOT_SUPPORTED;
--   * platform_settings.client_gate = 'require_marker' (switched on later, once Play users have the new version):
--     a request that does not name itself is refused too - every old APK (and any old build) stops for good.
--   * the server's own calls (service_role, edge functions, Platform Manager) are never touched.
-- Mode values: 'block_direct' (default), 'require_marker', 'off'.
-- Rollback: alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
--           drop function public.prosm_time_client_gate(); delete from platform_settings where key = 'client_gate'.
begin;

insert into public.platform_settings (key, value) values ('client_gate', '"block_direct"'::jsonb)
on conflict (key) do nothing;

create or replace function public.prosm_time_client_gate()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_user);
    v_info text;
    v_mode text;
begin
    if v_role in ('service_role', 'supabase_admin', 'postgres') then return; end if;
    begin
        v_info := lower(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-client-info', ''));
    exception when others then
        v_info := '';
    end;
    if v_info like 'prosm-time/direct/%' then
        raise exception 'APP_BUILD_NOT_SUPPORTED' using hint = 'Install PROSM Time from Google Play.', errcode = 'P0001';
    end if;
    if v_info like 'prosm-time/%' then return; end if;
    select value #>> '{}' into v_mode from platform_settings where key = 'client_gate';
    if coalesce(v_mode, 'block_direct') = 'require_marker' then
        raise exception 'APP_BUILD_NOT_SUPPORTED' using hint = 'Update PROSM Time from Google Play.', errcode = 'P0001';
    end if;
end;
$$;
revoke all on function public.prosm_time_client_gate() from public;
grant execute on function public.prosm_time_client_gate() to anon, authenticated;

-- (the test database has no PostgREST role: the check is wired only where it exists)
do $do$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticator') then
        execute 'alter role authenticator set pgrst.db_pre_request = ''public.prosm_time_client_gate''';
    end if;
end $do$;
notify pgrst, 'reload config';

commit;
