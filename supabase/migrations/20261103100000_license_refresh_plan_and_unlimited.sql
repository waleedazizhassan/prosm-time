-- 2026-11-03 (owner: "I added a device and a user to Ratomag in Platform Manager and the
-- header card did not change"). The refresh kept the old limits whenever Platform said
-- "no limit" (coalesce), and never took the plan. Now the refresh mirrors Platform:
-- users/devices exactly as Platform has them (empty = no limit), and the plan when
-- Platform names one (the plan trigger then sets the Time plan).
-- Rollback: drop this function and restore the 5-argument one from 20261027170000.

begin;

drop function if exists public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz);

create or replace function public.refresh_prosm_time_license_state(
    p_organization_id uuid,
    p_status text,
    p_max_users integer,
    p_max_devices integer,
    p_expires_at timestamptz,
    p_plan_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    if p_status not in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED') then
        raise exception 'INVALID LICENSE STATUS';
    end if;

    update license_activation_state
    set
        status = p_status,
        max_users = p_max_users,
        max_devices = p_max_devices,
        plan_id = coalesce(p_plan_id, plan_id),
        -- A renewal in Platform Manager extends the trial: its notices start again for the new end date.
        trial_reminder_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() + interval '7 days' then null else trial_reminder_sent_at end,
        trial_ended_notice_sent_at = case when p_expires_at is distinct from expires_at and p_expires_at > now() then null else trial_ended_notice_sent_at end,
        expires_at = p_expires_at,
        last_verified_at = now(),
        updated_at = now()
    where organization_id = p_organization_id;

    if not found then
        raise exception 'NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION';
    end if;

    return jsonb_build_object('success', true, 'organizationId', p_organization_id, 'status', p_status);
exception
    when others then
        raise exception 'REFRESH PROSM TIME LICENSE STATE FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.refresh_prosm_time_license_state(uuid, text, integer, integer, timestamptz, uuid) to service_role;

commit;
