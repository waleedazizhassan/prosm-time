-- 2026-11-02: a trial that becomes a paid licence stayed "trial" in entitlements,
-- so the plan's limits never applied and the owner saw "trial". A paid licence now
-- ends the trial state: the plan becomes legacy (no new limit) until PROSM sets one.
-- Rollback: restore prosm_time_entitlement_for_new_license from 20261101120000.

begin;

create or replace function public.prosm_time_entitlement_for_new_license()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    insert into entitlements (organization_id, plan, status, starts_at, ends_at, seats)
    values (new.organization_id, case when new.is_trial then 'pro' else 'legacy' end, case when new.is_trial then 'trial' else 'active' end, now(), new.expires_at, new.max_users)
    on conflict (organization_id) do update
    set plan = case
            when excluded.status = 'trial' then 'pro'
            when entitlements.status = 'trial' then 'legacy'
            else entitlements.plan
        end,
        status = case
            when excluded.status = 'trial' then 'trial'
            when entitlements.status = 'trial' then 'active'
            else entitlements.status
        end,
        seats = case when excluded.status <> 'trial' and entitlements.status = 'trial' then excluded.seats else entitlements.seats end,
        ends_at = excluded.ends_at, updated_at = now();
    return new;
end;
$function$;

-- Organisations already converted keep a stale trial row: correct them.
update public.entitlements e
set plan = 'legacy', status = 'active', updated_at = now()
from public.license_activation_state l
where l.organization_id = e.organization_id and not l.is_trial and e.status = 'trial';

commit;
