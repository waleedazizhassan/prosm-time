-- Owner 2026-11-16: "adjust the plans - a module was added and capabilities grew". Placed on the agreed tiers
-- (plans-pricing 2026-11-09):
--   * governance_models   (Business and up): the decentralized and centralized governance models;
--   * governance_advanced (Pro and up): the combined (two-step) model and a different model per request kind.
--   Starter keeps the simple model. Security (two-step verification / identity confirmation), employee codes and
--   the one-manager-per-administration rule are in every plan - they are not features to sell.
-- A plan that loses a model (downgrade) is decided as "simple" at once - nothing stays stuck on a model the plan
-- no longer has; the stored choice returns if the plan does.
-- Rollback: remove the two keys from plans.feature_flags; re-run prosm_time_approval_mode, set_prosm_time_approval_mode
-- and set_prosm_time_governance_model from 20261117100000 / 20261117120000.

begin;

update public.plans set feature_flags = feature_flags || '{"governance_models": true}'::jsonb where key = 'business';
update public.plans set feature_flags = feature_flags || '{"governance_models": true, "governance_advanced": true}'::jsonb where key in ('pro', 'enterprise', 'legacy');

create or replace function public.prosm_time_mode_allowed(p_org uuid, p_mode text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case p_mode
        when 'direct' then true
        when 'two_step' then public.prosm_time_plan_allows(p_org, 'governance_advanced')
        else public.prosm_time_plan_allows(p_org, 'governance_models')
    end;
$$;
revoke all on function public.prosm_time_mode_allowed(uuid, text) from public, anon, authenticated;

create or replace function public.prosm_time_approval_mode(p_org uuid, p_kind text)
returns text
language sql
stable
security definer
set search_path = public
as $$
    select case when public.prosm_time_mode_allowed(p_org, m.mode)
                     -- a different model per kind is itself an advanced (Pro) capability
                     and (public.prosm_time_plan_allows(p_org, 'governance_advanced')
                          or not exists (select 1 from approval_modes o where o.organization_id = p_org and o.mode <> m.mode))
                then m.mode else 'direct' end
    from (select coalesce((select mode from approval_modes where organization_id = p_org and request_kind = p_kind), 'direct') as mode) m;
$$;
revoke all on function public.prosm_time_approval_mode(uuid, text) from public, anon, authenticated;

-- the choices refuse what the plan does not include
do $$
declare
    v_def text;
    v_anchor text := $q$    if p_mode not in ('direct', 'decentralized', 'centralized', 'two_step') then raise exception 'INVALID REQUEST'; end if;$q$;
    v_guard text := $q$    if p_mode not in ('direct', 'decentralized', 'centralized', 'two_step') then raise exception 'INVALID REQUEST'; end if;
    if not public.prosm_time_mode_allowed(v_org, p_mode) then
        raise exception 'FEATURE NOT IN PLAN: %', case when p_mode = 'two_step' then 'governance_advanced' else 'governance_models' end;
    end if;$q$;
begin
    v_def := replace(pg_get_functiondef('public.set_prosm_time_governance_model(text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('prosm_time_mode_allowed' in v_def) = 0 then
        if position(v_anchor in v_def) = 0 then raise exception 'governance model: anchor not found'; end if;
        execute replace(v_def, v_anchor, v_guard);
    end if;
end $$;

do $$
declare
    v_def text;
    v_anchor text := $q$    v_old := public.prosm_time_approval_mode(v_org, p_kind);$q$;
    v_guard text := $q$    -- per-kind tuning is the advanced (Pro) capability; the models themselves follow the plan too
    perform public.prosm_time_require_feature('governance_advanced');
    v_old := public.prosm_time_approval_mode(v_org, p_kind);$q$;
begin
    v_def := replace(pg_get_functiondef('public.set_prosm_time_approval_mode(text, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('governance_advanced' in v_def) = 0 then
        if position(v_anchor in v_def) = 0 then raise exception 'approval mode: anchor not found'; end if;
        execute replace(v_def, v_anchor, v_guard);
    end if;
end $$;

commit;
