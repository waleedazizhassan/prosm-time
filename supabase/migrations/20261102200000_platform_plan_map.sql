-- 2026-11-02: a code from PROSM Platform Manager now sets the matching PROSM Time plan.
-- Platform sends its own plan id; this table says which Time plan it is:
-- free = starter, professional = business, enterprise = pro.
-- Organisations that existed before plans keep "legacy" (no new limit) whatever
-- their licence says, so a renewal never puts limits on them by surprise.
-- Rollback: drop the table, restore prosm_time_entitlement_for_new_license from
-- 20261102170000 and the trigger's column list (is_trial, expires_at).

begin;

create table public.platform_plan_map (
    platform_plan_id uuid primary key,
    plan text not null references public.plans(key),
    platform_plan_key text not null
);
alter table public.platform_plan_map enable row level security;
revoke all on public.platform_plan_map from anon, authenticated;

insert into public.platform_plan_map (platform_plan_id, plan, platform_plan_key) values
    ('d6ff925e-5008-4fe0-899d-5a87453bc3f8', 'starter', 'free'),
    ('be13be26-7496-47b4-b088-43eaf3079f74', 'business', 'professional'),
    ('8fc0af08-e6ca-4f39-a9e8-d9c2a981c660', 'pro', 'enterprise');

create or replace function public.prosm_time_entitlement_for_new_license()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_mapped text := (select m.plan from platform_plan_map m where m.platform_plan_id = new.plan_id);
begin
    insert into entitlements (organization_id, plan, status, starts_at, ends_at, seats)
    values (new.organization_id,
            case when new.is_trial then 'pro' else coalesce(v_mapped, 'legacy') end,
            case when new.is_trial then 'trial' else 'active' end, now(), new.expires_at, new.max_users)
    on conflict (organization_id) do update
    set plan = case
            when excluded.status = 'trial' then 'pro'
            when entitlements.notes = 'existing before plans' then entitlements.plan
            when v_mapped is not null then v_mapped
            when entitlements.status = 'trial' then 'legacy'
            else entitlements.plan
        end,
        status = case
            when excluded.status = 'trial' then 'trial'
            when entitlements.status = 'trial' then 'active'
            else entitlements.status
        end,
        seats = case when excluded.status <> 'trial' and (entitlements.status = 'trial' or v_mapped is not null) then excluded.seats else entitlements.seats end,
        ends_at = excluded.ends_at, updated_at = now();
    return new;
end;
$function$;

drop trigger license_keeps_entitlement on public.license_activation_state;
create trigger license_keeps_entitlement
after insert or update of is_trial, expires_at, plan_id on public.license_activation_state
for each row execute function public.prosm_time_entitlement_for_new_license();

commit;
