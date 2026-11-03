-- 2026-11-02 (plan stage 3.3, the privacy policy's "kept read-only"): after the grace,
-- an ended organisation can still be read by its people, and nothing it holds can be
-- changed from the app until it is reopened. Behind platform_settings
-- 'locked_organizations_read_only' (on). Off = the earlier full lock.
-- Writes are refused on every working table for a signed-in caller of a locked
-- organisation; what keeps the app usable stays open: sign-in and devices, consents,
-- notifications, reading photos (logged), exporting, the licence itself, and SOS.
-- Rollback: set the setting to false (immediate), or drop the guard triggers and
-- restore current_prosm_time_organization_id and get_prosm_time_trial_status from 20261027170000.

begin;

insert into public.platform_settings (key, value) values ('locked_organizations_read_only', 'true'::jsonb)
on conflict (key) do nothing;

create or replace function public.prosm_time_read_only_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select value = 'true'::jsonb from platform_settings where key = 'locked_organizations_read_only'), false);
$$;
revoke all on function public.prosm_time_read_only_enabled() from public, anon, authenticated;

create or replace function public.current_prosm_time_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select u.organization_id from public.users u
    where u.auth_user_id = auth.uid() and u.is_active = true
      and (not public.prosm_time_org_locked(u.organization_id) or public.prosm_time_read_only_enabled());
$function$;

create or replace function public.current_prosm_time_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
    select u.id from public.users u
    where u.auth_user_id = auth.uid() and u.is_active = true
      and (not public.prosm_time_org_locked(u.organization_id) or public.prosm_time_read_only_enabled());
$function$;

create or replace function public.get_prosm_time_trial_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
    select coalesce((
        select jsonb_build_object(
            'isTrial', l.is_trial,
            'locked', public.prosm_time_org_locked(l.organization_id),
            'licenseEnded', not l.is_trial and public.prosm_time_org_locked(l.organization_id),
            'readOnly', public.prosm_time_org_locked(l.organization_id) and public.prosm_time_read_only_enabled(),
            'expiresAt', l.expires_at,
            'daysLeft', case when l.expires_at is null then null else greatest(0, ceil(extract(epoch from (l.expires_at - now())) / 86400)::int) end,
            'licenseNumber', case when u.is_owner then l.license_number else null end,
            'isOwner', u.is_owner,
            'organizationName', o.name,
            'serverTime', now())
        from users u
        join license_activation_state l on l.organization_id = u.organization_id
        join organizations o on o.id = u.organization_id
        where u.auth_user_id = auth.uid() and u.is_active = true
        limit 1), jsonb_build_object('isTrial', false, 'locked', false));
$function$;

-- The guard: a signed-in caller cannot change a locked organisation's records.
-- Server jobs (no caller) still run: retention purges, reminders that skip locked
-- organisations anyway.
create or replace function public.prosm_time_refuse_when_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
begin
    if auth.uid() is not null and v_org is not null and public.prosm_time_org_locked(v_org) then
        raise exception 'ORGANIZATION IS READ ONLY';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.prosm_time_refuse_when_locked() from public, anon, authenticated;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'admin_on_behalf_actions', 'allowance_basis', 'allowance_categories', 'allowance_category_members', 'allowance_entries',
        'allowance_entry_adjustments', 'allowance_preferences', 'allowance_rates', 'allowance_sheets', 'api_keys',
        'attendance_day_adjustments', 'attendance_permissions', 'attendance_sessions', 'break_events', 'camera_evidence',
        'capture_tokens', 'correction_requests', 'exception_actions', 'geofence_exceptions', 'integrity_flags',
        'leave_entitlements', 'leave_requests', 'leave_types', 'location_plausibility_flags', 'mock_location_flags',
        'offline_time_reviews', 'open_shift_requests', 'open_shifts', 'organization_settings', 'overtime_policies',
        'payroll_adjustments', 'payroll_export_templates', 'presence_sessions', 'public_holidays', 'schedule_exceptions',
        'session_checklist_answers', 'shift_assignments', 'shift_swap_requests', 'shift_templates', 'site_change_events',
        'site_checklist_items', 'site_worker_attendance', 'site_workers', 'sites', 'timesheet_approvals',
        'timesheet_corrections', 'timesheets', 'worker_pay_rates'
    ] loop
        execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.prosm_time_refuse_when_locked()',
                       v_table || '_read_only_when_locked', v_table);
    end loop;
    -- no new people join a locked organisation; existing ones keep their profile
    execute 'create trigger users_read_only_when_locked before insert on public.users for each row execute function public.prosm_time_refuse_when_locked()';
end $$;

commit;
