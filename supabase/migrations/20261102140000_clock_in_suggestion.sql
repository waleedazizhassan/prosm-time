-- 2026-11-02 (plan stage 8.4): the organisation may let the app suggest the site a
-- person is standing in when they open it. It records nothing by itself and uses no
-- background location; the person taps, and the ordinary rules apply. Off by default.
-- Rollback: drop the function and the column.

begin;

alter table public.organization_settings add column suggest_clock_in boolean not null default false;

create or replace function public.set_prosm_time_clock_suggestion(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CHANGES THIS SETTING'; end if;
    update organization_settings set suggest_clock_in = coalesce(p_enabled, false) where organization_id = v_org;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
    values (v_org, public.current_prosm_time_user_id(), 'settings.clock_suggestion', 'organization_settings', 'Clock-in suggestion changed', jsonb_build_object('enabled', coalesce(p_enabled, false)));
end;
$$;
revoke all on function public.set_prosm_time_clock_suggestion(boolean) from public, anon;
grant execute on function public.set_prosm_time_clock_suggestion(boolean) to authenticated;

commit;
