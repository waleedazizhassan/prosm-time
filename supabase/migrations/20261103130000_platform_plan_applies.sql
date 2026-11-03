-- 2026-11-03 (owner: "I changed Ratomag to Enterprise in Platform Manager but the plan
-- card still says 'your current plan'"). An organisation from before plans kept 'legacy'
-- whatever Platform said. Now a plan that Platform Manager explicitly sets (the licence's
-- plan changes to a mapped plan) applies to every organisation; with no change from
-- Platform, an older organisation keeps its legacy plan as before. The licence-change
-- notification names the new plan.
-- Rollback: restore prosm_time_entitlement_for_new_license from 20261102200000 and
-- prosm_time_notify_license_change from 20261103110000; set the plan of the organisations
-- updated below back to 'legacy' with notes 'existing before plans'.

begin;

create or replace function public.prosm_time_entitlement_for_new_license()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_mapped text := (select m.plan from platform_plan_map m where m.platform_plan_id = new.plan_id);
    v_explicit boolean := tg_op = 'UPDATE' and new.plan_id is distinct from old.plan_id and v_mapped is not null and not new.is_trial;
begin
    insert into entitlements (organization_id, plan, status, starts_at, ends_at, seats)
    values (new.organization_id,
            case when new.is_trial then 'pro' else coalesce(v_mapped, 'legacy') end,
            case when new.is_trial then 'trial' else 'active' end, now(), new.expires_at, new.max_users)
    on conflict (organization_id) do update
    set plan = case
            when excluded.status = 'trial' then 'pro'
            when v_explicit then v_mapped
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
        notes = case when v_explicit then 'set from Platform Manager' else entitlements.notes end,
        seats = case when excluded.status <> 'trial' and (entitlements.status = 'trial' or v_mapped is not null) then excluded.seats else entitlements.seats end,
        ends_at = excluded.ends_at, updated_at = now();
    return new;
end;
$function$;

-- Organisations whose plan Platform Manager already set while they were kept on legacy (Ratomag today).
update entitlements e
set plan = m.plan, notes = 'set from Platform Manager', seats = l.max_users, updated_at = now()
from license_activation_state l
join platform_plan_map m on m.platform_plan_id = l.plan_id
where l.organization_id = e.organization_id
  and e.plan = 'legacy' and e.notes = 'existing before plans' and not l.is_trial;

-- The licence-change notification names the plan.
create or replace function public.prosm_time_notify_license_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner uuid;
    v_data jsonb;
    v_parts text[] := '{}';
    v_plan_name text;
    v_users_changed boolean := new.max_users is distinct from old.max_users;
    v_devices_changed boolean := new.max_devices is distinct from old.max_devices;
    v_expiry_changed boolean := new.expires_at::date is distinct from old.expires_at::date;
    v_status_changed boolean := new.status is distinct from old.status;
    v_plan_changed boolean := new.plan_id is distinct from old.plan_id;
begin
    if not (v_users_changed or v_devices_changed or v_expiry_changed or v_status_changed or v_plan_changed) then
        return new;
    end if;

    v_data := jsonb_build_object('licenseNumber', new.license_number);
    if v_users_changed then
        v_data := v_data || jsonb_build_object('usersFrom', old.max_users, 'usersTo', new.max_users, 'usersChanged', true);
        v_parts := v_parts || ('users ' || coalesce(old.max_users::text, 'unlimited') || ' -> ' || coalesce(new.max_users::text, 'unlimited'));
    end if;
    if v_devices_changed then
        v_data := v_data || jsonb_build_object('devicesFrom', old.max_devices, 'devicesTo', new.max_devices, 'devicesChanged', true);
        v_parts := v_parts || ('devices ' || coalesce(old.max_devices::text, 'unlimited') || ' -> ' || coalesce(new.max_devices::text, 'unlimited'));
    end if;
    if v_expiry_changed then
        v_data := v_data || jsonb_build_object('expiresAt', new.expires_at, 'expiryChanged', true);
        v_parts := v_parts || ('ends ' || coalesce(to_char(new.expires_at, 'YYYY-MM-DD'), 'never'));
    end if;
    if v_status_changed then
        v_data := v_data || jsonb_build_object('status', new.status, 'statusChanged', true);
        v_parts := v_parts || ('status ' || new.status);
    end if;
    if v_plan_changed then
        select m.plan into v_plan_name from platform_plan_map m where m.platform_plan_id = new.plan_id;
        v_data := v_data || jsonb_build_object('planChanged', true, 'plan', v_plan_name);
        v_parts := v_parts || ('plan ' || coalesce(v_plan_name, 'changed'));
    end if;

    for v_owner in select id from users where organization_id = new.organization_id and is_owner and is_active loop
        perform public.create_prosm_time_notification(
            new.organization_id, v_owner, 'license_changed', 'high', 'Your licence was changed',
            'PROSM changed your licence: ' || array_to_string(v_parts, ', ') || '.',
            'license_activation_state', new.id, v_data
        );
    end loop;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, previous_state, new_state)
    values (new.organization_id, null, 'license.changed', 'license_activation_state', 'Licence changed in PROSM Platform',
        jsonb_build_object('maxUsers', old.max_users, 'maxDevices', old.max_devices, 'expiresAt', old.expires_at, 'status', old.status, 'planId', old.plan_id),
        jsonb_build_object('maxUsers', new.max_users, 'maxDevices', new.max_devices, 'expiresAt', new.expires_at, 'status', new.status, 'planId', new.plan_id));
    return new;
end;
$$;

commit;
