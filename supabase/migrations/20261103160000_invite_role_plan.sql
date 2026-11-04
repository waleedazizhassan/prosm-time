-- 2026-11-03: a person's role is set when they are invited (invite-user, with the server's
-- rights, so the users table guard of 20261103140000 - which checks a signed-in caller -
-- does not see it). The invitation itself now checks the role against the plan: manager
-- and supervisor are Business and up, the viewer (read_only) is Pro.
-- Rollback: remove the "perform public.prosm_time_check_role_plan" line from
-- create_invited_prosm_time_user; drop prosm_time_check_role_plan(uuid, text).

begin;

create or replace function public.prosm_time_check_role_plan(p_org uuid, p_role_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if p_role_key in ('manager', 'supervisor') and not public.prosm_time_plan_allows(p_org, 'roles_manager') then
        raise exception 'FEATURE NOT IN PLAN: roles_manager';
    end if;
    if p_role_key = 'read_only' and not public.prosm_time_plan_allows(p_org, 'roles_all') then
        raise exception 'FEATURE NOT IN PLAN: roles_all';
    end if;
end;
$$;
revoke all on function public.prosm_time_check_role_plan(uuid, text) from public, anon, authenticated;

do $$
declare
    v_def text;
    v_new text;
begin
    for v_def in
        select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_invited_prosm_time_user'
    loop
        continue when position('prosm_time_check_role_plan' in v_def) > 0;
        v_new := regexp_replace(v_def, E'(\\n[ \\t]*begin\\M[^\\n]*\\n)', '\1    perform public.prosm_time_check_role_plan(p_organization_id, p_role_key);' || chr(10), 'i');
        if v_new = v_def then raise exception 'NO BEGIN FOUND IN create_invited_prosm_time_user'; end if;
        execute v_new;
    end loop;
end $$;

commit;
