-- 2026-11-08 security and performance hardening (from the full audit):
--   1. Site scope: a manager reads shifts, external workers and their attendance at the sites
--      they manage - not every site of the organisation.
--   2. Internal helpers that answered for any organisation's ids are no longer callable by
--      users (site location probe, timezone, allowance basis); the plan history start answers
--      only for the caller's own organisation.
--   3. One audit trigger for the governance, settings and decision tables whose changes were not
--      in the action log (timesheet decisions, corrections, exceptions, entitlements, external
--      workers, shift templates/assignments, open shifts, allowance categories, organisation and
--      site settings, report exports, plan changes) - with the delegation context.
--   4. RLS performance: the permission list, the managed sites and the owner check are computed
--      once per query (initplan), not once per row.
--   5. Indexes on organization_id and on the foreign keys the screens filter by.
--   6. Leftover client write/REFERENCES grants removed.
-- Rollback: recreate the policies from their previous migrations, drop the trigger
-- prosm_time_audit_row_change on the listed tables, re-grant execute on the helpers.

begin;

-- 1. Site scope ------------------------------------------------------------------------------
drop policy if exists "members can view own shift assignments" on public.shift_assignments;
create policy "members can view own shift assignments" on public.shift_assignments for select to authenticated
    using (
        organization_id = (select public.current_prosm_time_organization_id())
        and (
            user_id = (select public.current_prosm_time_user_id())
            or (select public.current_prosm_time_user_is_owner())
            or (
                'schedules.manage' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
                and site_id = any((select public.current_prosm_time_managed_site_ids())::uuid[])
            )
        )
    );

drop policy if exists "managers view own organization site workers" on public.site_workers;
create policy "managers view own organization site workers" on public.site_workers for select to authenticated
    using (
        organization_id = (select public.current_prosm_time_organization_id())
        and (
            (select public.current_prosm_time_user_is_owner())
            or (
                'sites.manage' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
                -- not yet placed at a site: visible to those who place workers; placed: their sites only
                and (site_id is null or site_id = any((select public.current_prosm_time_managed_site_ids())::uuid[]))
            )
        )
    );

drop policy if exists "managers view own organization site worker attendance" on public.site_worker_attendance;
create policy "managers view own organization site worker attendance" on public.site_worker_attendance for select to authenticated
    using (
        organization_id = (select public.current_prosm_time_organization_id())
        and (
            (select public.current_prosm_time_user_is_owner())
            or (
                'sites.manage' = any(coalesce((select public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id())), array[]::text[]))
                and site_id = any((select public.current_prosm_time_managed_site_ids())::uuid[])
            )
        )
    );

-- 2. Helpers that answered for any organisation ----------------------------------------------
revoke execute on function public.compute_prosm_time_geofence_check(uuid, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.prosm_time_allowance_basis(uuid) from public, anon, authenticated;
revoke execute on function public.prosm_time_site_timezone(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.prosm_time_work_date(timestamptz, uuid, uuid) from public, anon, authenticated;

-- Still used by the history-window policies (run as the user): answers for one's own organisation only.
create or replace function public.prosm_time_history_start_date(p_org uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
    select case
        when auth.uid() is not null and p_org is distinct from public.current_prosm_time_organization_id() then null
        else coalesce((
            select case when e.plan = 'legacy' or e.status = 'trial' or p.history_days is null then '-infinity'::date
                        else current_date - p.history_days end
            from entitlements e join plans p on p.key = e.plan
            where e.organization_id = p_org), '-infinity'::date)
    end;
$$;

-- 3. One audit trigger -----------------------------------------------------------------------
create or replace function public.prosm_time_audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
    v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
    v_row jsonb := coalesce(v_new, v_old);
    v_org uuid;
    v_actor uuid;
    v_subject uuid;
    v_entity uuid;
    v_delegation owner_delegations%rowtype;
    v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
    -- only what a person does (server jobs and the seeding of new organisations are not actions)
    if auth.uid() is null then return null; end if;
    if tg_op = 'UPDATE' and (v_new - 'updated_at') = (v_old - 'updated_at') then return null; end if;
    v_org := case when coalesce(v_row ->> 'organization_id', '') ~ v_uuid then (v_row ->> 'organization_id')::uuid end;
    if v_org is null and tg_table_name = 'organization_settings' then v_org := (v_row ->> 'organization_id')::uuid; end if;
    if v_org is null then return null; end if;
    v_actor := public.current_prosm_time_user_id();
    v_subject := case when coalesce(v_row ->> 'user_id', '') ~ v_uuid then (v_row ->> 'user_id')::uuid end;
    v_entity := case when coalesce(v_row ->> 'id', '') ~ v_uuid then (v_row ->> 'id')::uuid end;
    select * into v_delegation from public.prosm_time_active_delegation(v_actor) where id is not null;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state, new_state, context)
    values (
        v_org, v_actor, v_subject,
        tg_table_name || '.' || lower(tg_op), tg_table_name, v_entity,
        'Recorded automatically',
        v_old, v_new,
        jsonb_build_object('source', 'row_change')
            || case when v_delegation.id is not null
                    then jsonb_build_object('delegationId', v_delegation.id, 'onBehalfOf', v_delegation.granted_by, 'delegationScope', v_delegation.scope)
                    else '{}'::jsonb end
    );
    return null;
exception when others then
    -- the action log never blocks the action itself
    return null;
end;
$$;
revoke all on function public.prosm_time_audit_row_change() from public, anon, authenticated;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'timesheet_approvals', 'timesheet_corrections', 'exception_actions', 'leave_entitlements',
        'site_workers', 'shift_templates', 'shift_assignments', 'open_shifts', 'open_shift_requests',
        'allowance_categories', 'allowance_category_members', 'site_checklist_items', 'payroll_export_templates',
        'organization_settings', 'sites', 'report_exports', 'entitlements'
    ] loop
        execute format('drop trigger if exists %I on public.%I', v_table || '_audit_row_change', v_table);
        execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.prosm_time_audit_row_change()',
                       v_table || '_audit_row_change', v_table);
    end loop;
end $$;

-- 4. RLS performance: compute the caller's context once per query ----------------------------
do $$
declare
    v_policy record;
    v_qual text;
    v_new text;
begin
    for v_policy in
        select schemaname, tablename, policyname, qual from pg_policies
        where schemaname = 'public' and qual is not null
          and qual ~ '(get_prosm_time_effective_permissions\(current_prosm_time_user_id\(\)\)|current_prosm_time_managed_site_ids\(\)|current_prosm_time_user_is_owner\(\))'
    loop
        v_qual := v_policy.qual;
        v_new := v_qual;
        v_new := replace(v_new, 'get_prosm_time_effective_permissions(current_prosm_time_user_id())', '( SELECT get_prosm_time_effective_permissions(current_prosm_time_user_id()) )');
        v_new := regexp_replace(v_new, '(?<!SELECT )current_prosm_time_managed_site_ids\(\)', '( SELECT current_prosm_time_managed_site_ids() )::uuid[]', 'g');
        v_new := regexp_replace(v_new, '(?<!SELECT )current_prosm_time_user_is_owner\(\)', '( SELECT current_prosm_time_user_is_owner() )', 'g');
        if v_new <> v_qual then
            execute format('alter policy %I on public.%I using (%s)', v_policy.policyname, v_policy.tablename, v_new);
        end if;
    end loop;
end $$;

-- 5. Indexes ---------------------------------------------------------------------------------
do $$
declare
    v_pair text[];
begin
    foreach v_pair slice 1 in array array[
        ['allowance_category_members', 'organization_id'], ['allowance_entry_adjustments', 'organization_id'],
        ['allowance_preferences', 'organization_id'], ['attendance_day_adjustments', 'organization_id'],
        ['capture_tokens', 'organization_id'], ['clock_reminder_log', 'organization_id'],
        ['dashboard_preferences', 'organization_id'], ['data_consents', 'organization_id'],
        ['data_deletion_log', 'organization_id'], ['entitlement_events', 'organization_id'],
        ['exception_actions', 'organization_id'], ['known_login_devices', 'organization_id'],
        ['manager_alert_log', 'organization_id'], ['notifications', 'organization_id'],
        ['open_shift_requests', 'organization_id'], ['open_shifts', 'organization_id'],
        ['payroll_adjustments', 'organization_id'], ['push_devices', 'organization_id'],
        ['session_checklist_answers', 'organization_id'], ['site_checklist_items', 'organization_id'],
        ['timesheet_approvals', 'organization_id'], ['timesheet_corrections', 'organization_id'],
        ['attendance_sessions', 'site_id'], ['attendance_sessions', 'project_id'],
        ['presence_sessions', 'site_id'], ['location_samples', 'user_id'], ['sos_alerts', 'site_id'],
        ['allowance_entries', 'attendance_session_id'], ['allowance_entries', 'sheet_id'],
        ['allowance_sheets', 'user_id'], ['allowance_rates', 'user_id'], ['allowance_rates', 'site_id'],
        ['correction_requests', 'attendance_session_id'], ['geofence_exceptions', 'attendance_event_id'],
        ['geofence_exceptions', 'presence_session_id'], ['integrity_flags', 'user_id'],
        ['open_shifts', 'site_id'], ['open_shift_requests', 'user_id'], ['shift_assignments', 'shift_template_id'],
        ['shift_swap_requests', 'from_user_id'], ['shift_swap_requests', 'to_user_id'],
        ['site_change_events', 'old_site_id'], ['site_change_events', 'new_site_id'],
        ['site_worker_attendance', 'site_id'], ['schedule_exceptions', 'user_id'], ['schedule_exceptions', 'site_id'],
        ['public_holidays', 'site_id'], ['leave_requests', 'requested_reviewer_id'],
        ['timesheet_corrections', 'requested_by'], ['users', 'role_id'],
        ['user_permission_overrides', 'permission_id'], ['role_default_permissions', 'permission_id'],
        ['audit_logs', 'subject_user_id'], ['audit_logs', 'actor_user_id']
    ] loop
        if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = v_pair[1] and column_name = v_pair[2]) then
            execute format('create index if not exists %I on public.%I (%I)', v_pair[1] || '_' || v_pair[2] || '_idx', v_pair[1], v_pair[2]);
        end if;
    end loop;
end $$;

-- 6. Leftover grants ---------------------------------------------------------------------------
revoke insert, update, delete, references on public.data_consents from authenticated, anon;
revoke references on public.legal_acknowledgements, public.mock_location_flags, public.offline_time_reviews, public.owner_delegations from authenticated, anon;

commit;
