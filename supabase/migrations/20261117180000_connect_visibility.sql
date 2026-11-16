-- Owner 2026-11-16 (Connect - who sees whom):
--   * managers - the manager role, a department's manager, a site's manager - see each other and everyone, anywhere,
--     and may contact anyone;
--   * employees see only the people of their own sites and their own department (and their department's manager);
--   * the organisation's owner sees everyone and nobody sees the owner (the owner may write first; then a reply works);
--   * supervisors ("you choose; I agree"): their sites and their department, plus every manager (to escalate).
-- A conversation that already exists can always be answered (a manager from elsewhere wrote first).
-- Enforced on the server for the people list, opening a chat, calls, every message, groups and meetings.
-- Rollback: drop the three functions; re-run list_prosm_time_connect_people / prosm_time_connect_open_direct /
-- prosm_time_connect_start_call / prosm_time_connect_may_send / create_group / update_group / start_meeting from
-- their previous migrations (20261114100000 .. 20261117170000).

begin;

-- a lead: the owner, the manager role, a department's manager or a site's manager
create or replace function public.prosm_time_connect_is_lead(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from users u left join roles r on r.id = u.role_id where u.id = p_user and (u.is_owner or r.role_key = 'manager'))
        or exists (select 1 from departments d where d.manager_user_id = p_user and d.is_active)
        or exists (select 1 from site_assignments sa where sa.user_id = p_user and sa.role_at_site = 'manager');
$$;
revoke all on function public.prosm_time_connect_is_lead(uuid) from public, anon, authenticated;

-- does p_viewer see p_target in Connect?
create or replace function public.prosm_time_connect_sees(p_viewer uuid, p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with v as (select u.id, u.organization_id, u.is_owner, u.department_id, r.role_key from users u left join roles r on r.id = u.role_id where u.id = p_viewer),
         t as (select u.id, u.organization_id, u.is_owner, u.department_id from users u where u.id = p_target and u.is_active)
    select coalesce((
        select case
            when v.id = t.id then true
            when t.is_owner then false                                   -- nobody sees the owner
            when v.is_owner or public.prosm_time_connect_is_lead(v.id) then true
            else
                -- the same site, the same department, the department's manager
                exists (select 1 from site_assignments a join site_assignments b on b.site_id = a.site_id where a.user_id = v.id and b.user_id = t.id)
                or (v.department_id is not null and v.department_id = t.department_id)
                or exists (select 1 from departments d where d.id = v.department_id and d.manager_user_id = t.id)
                -- a supervisor also reaches every manager
                or (v.role_key = 'supervisor' and public.prosm_time_connect_is_lead(t.id))
        end
        from v join t on t.organization_id = v.organization_id), false);
$$;
revoke all on function public.prosm_time_connect_sees(uuid, uuid) from public, anon, authenticated;

-- may p_from contact p_to: they see them, or a conversation between them already exists (an answer)
create or replace function public.prosm_time_connect_can_reach(p_from uuid, p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.prosm_time_connect_sees(p_from, p_to)
        or exists (select 1 from connect_conversations c
                   where c.direct_key = least(p_from::text, p_to::text) || ':' || greatest(p_from::text, p_to::text));
$$;
revoke all on function public.prosm_time_connect_can_reach(uuid, uuid) from public, anon, authenticated;

-- the people list: whom the caller sees (and themselves)
do $$
declare
    v_def text := replace(pg_get_functiondef('public.list_prosm_time_connect_people()'::regprocedure), chr(13) || chr(10), chr(10));
    v_old text := $q$    where u.is_active and u.status = 'active'$q$;
    v_new text := $q$    where u.is_active and u.status = 'active'
      and public.prosm_time_connect_sees(public.current_prosm_time_user_id(), u.id)$q$;
begin
    if position('prosm_time_connect_sees' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'people list: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

-- opening a chat, starting a call (after the plan and "user not found" checks), groups, meetings
do $$
declare
    v_def text;
    v_anchor text := $q$        raise exception 'USER NOT FOUND';
    end if;$q$;
begin
    v_def := replace(pg_get_functiondef('public.prosm_time_connect_open_direct(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_connect_can_reach' in v_def) = 0 then
        if position(v_anchor in v_def) = 0 then raise exception 'open direct: anchor not found'; end if;
        execute replace(v_def, v_anchor, v_anchor || E'\n    if not public.prosm_time_connect_can_reach(v_me, p_other) then raise exception ''YOU CANNOT CONTACT THIS PERSON''; end if;');
    end if;
    v_def := replace(pg_get_functiondef('public.prosm_time_connect_start_call(uuid, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_connect_can_reach' in v_def) = 0 then
        if position(v_anchor in v_def) = 0 then raise exception 'start call: anchor not found'; end if;
        execute replace(v_def, v_anchor, v_anchor || E'\n    if not public.prosm_time_connect_can_reach(v_me, p_callee) then raise exception ''YOU CANNOT CONTACT THIS PERSON''; end if;');
    end if;
    v_def := replace(pg_get_functiondef('public.prosm_time_connect_create_group(text, uuid[])'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_connect_sees' in v_def) = 0 then
        execute regexp_replace(v_def, E'(\\n[ \\t]*begin[ \\t]*\\n)',
            E'\\1    if exists (select 1 from unnest(coalesce(p_members, array[]::uuid[])) m join users x on x.id = m and x.organization_id = public.current_prosm_time_organization_id() where not public.prosm_time_connect_sees(public.current_prosm_time_user_id(), m)) then raise exception ''YOU CANNOT CONTACT THIS PERSON''; end if;\n', 'i');
    end if;
    v_def := replace(pg_get_functiondef('public.prosm_time_connect_start_meeting(text, uuid[], text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_connect_sees' in v_def) = 0 then
        execute regexp_replace(v_def, E'(\\n[ \\t]*begin[ \\t]*\\n)',
            E'\\1    if exists (select 1 from unnest(coalesce(p_invitees, array[]::uuid[])) m join users x on x.id = m and x.organization_id = public.current_prosm_time_organization_id() where not public.prosm_time_connect_sees(public.current_prosm_time_user_id(), m)) then raise exception ''YOU CANNOT CONTACT THIS PERSON''; end if;\n', 'i');
    end if;
end $$;

do $$
declare
    v_sig regprocedure := (select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'prosm_time_connect_update_group' order by p.oid desc limit 1);
    v_def text := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
begin
    if position('prosm_time_connect_sees' in v_def) = 0 then
        execute regexp_replace(v_def, E'(\\n[ \\t]*begin[ \\t]*\\n)',
            E'\\1    if exists (select 1 from unnest(coalesce(p_add, array[]::uuid[])) m join users x on x.id = m and x.organization_id = public.current_prosm_time_organization_id() where not public.prosm_time_connect_sees(public.current_prosm_time_user_id(), m)) then raise exception ''YOU CANNOT CONTACT THIS PERSON''; end if;\n', 'i');
    end if;
end $$;

-- every direct message
do $$
declare
    v_def text := replace(pg_get_functiondef('public.prosm_time_connect_may_send(uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz, text)'::regprocedure), chr(13) || chr(10), chr(10));
    v_old text := $q$            and exists (select 1 from users u where u.id = p_to and u.organization_id = p_org and u.is_active))$q$;
    v_new text := $q$            and exists (select 1 from users u where u.id = p_to and u.organization_id = p_org and u.is_active)
            and public.prosm_time_connect_can_reach(p_from, p_to))$q$;
begin
    if position('prosm_time_connect_can_reach' in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'may send: anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;

commit;
