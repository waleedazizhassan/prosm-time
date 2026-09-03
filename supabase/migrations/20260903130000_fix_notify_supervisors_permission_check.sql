-- PROSM Time - real bug found while live-testing the notification
-- localization migration (20260903120000): notify_prosm_time_supervisors
-- looped over every org member calling the AUTHORITY-GATED
-- get_prosm_time_effective_permissions(u.id) to check for
-- 'exceptions.manage'/'attendance.clock_out_on_behalf' - but that
-- function raises 'INSUFFICIENT AUTHORITY TO VIEW ANOTHER USER'S
-- PERMISSIONS' whenever the ACTUAL caller (the employee clocking in/
-- out, from the real request JWT - this is SECURITY DEFINER, but that
-- function still resolves the caller via current_prosm_time_user_id())
-- isn't themselves an owner/admin. Since this fires from inside
-- clock_in/clock_out's own exception handler, an ordinary employee's
-- out-of-zone clock-in/out has been failing outright (as "CLOCK IN
-- FAILED: ...INSUFFICIENT AUTHORITY...") the moment the organization
-- has more than one relevant supervisor candidate to check - this was
-- never specific to notifications, it silently broke the underlying
-- attendance action itself.
--
-- Fix: this is an internal system computation (which org members
-- qualify as supervisors to notify), not a user asking to view
-- someone else's permissions - the authority gate does not apply here.
-- Inlines the exact same effective-permission computation
-- get_prosm_time_effective_permissions itself uses (role defaults
-- union granted overrides except revoked overrides - migration
-- 20260831130000, lines 265-283) directly, per candidate, bypassing
-- the gated wrapper entirely.

begin;

create or replace function public.notify_prosm_time_supervisors(
    p_organization_id uuid,
    p_type text,
    p_priority text,
    p_title text,
    p_body text,
    p_related_entity_type text default null,
    p_related_entity_id uuid default null,
    p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_supervisor record;
begin
    for v_supervisor in
        select u.id
        from users u
        where u.organization_id = p_organization_id
        and (
            u.is_owner
            or exists (
                select 1 from (
                    select p.permission_key
                    from role_default_permissions rdp
                    join permissions p on p.id = rdp.permission_id
                    where rdp.role_id = u.role_id
                    union
                    select p.permission_key
                    from user_permission_overrides upo
                    join permissions p on p.id = upo.permission_id
                    where upo.user_id = u.id and upo.is_granted = true
                    except
                    select p.permission_key
                    from user_permission_overrides upo
                    join permissions p on p.id = upo.permission_id
                    where upo.user_id = u.id and upo.is_granted = false
                ) effective
                where effective.permission_key in ('exceptions.manage', 'attendance.clock_out_on_behalf')
            )
        )
    loop
        perform public.create_prosm_time_notification(p_organization_id, v_supervisor.id, p_type, p_priority, p_title, p_body, p_related_entity_type, p_related_entity_id, p_data);
    end loop;
end;
$function$;

revoke execute on function public.notify_prosm_time_supervisors(uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated;

commit;
