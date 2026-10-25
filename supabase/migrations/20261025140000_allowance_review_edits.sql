-- PROSM Time v2.3.43, step 5 (item 21): while a manager reviews an
-- allowance sheet (before approval), one authorised for it
-- (allowances.edit_during_review, only for people at the sites they manage)
-- can change the value of any allowance line of any day in the sheet:
--   * the reason is required; the change is audited (who, employee/sheet,
--     line, value before and after, reason, time, sheet status) and kept in
--     allowance_entry_adjustments;
--   * the line is marked as changed (allowance_entries.manual_overrides keeps
--     the value set and the value it replaced) and later recalculations keep
--     the manager's value; the sheet's total follows at once;
--   * after approval nothing changes, except through an explicit reopening
--     (allowances.reopen_approved - the Owner by default) with a reason, audited.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('allowances.edit_during_review', 'allowances', 'EDIT', 'Edit allowances during review',
     'Change allowance lines of a sheet being reviewed, for people at the sites one manages (reason required, audited).'),
    ('allowances.reopen_approved', 'allowances', 'ADMINISTER', 'Reopen an approved allowance sheet',
     'Send an approved allowance sheet back to review to correct it (reason required, audited).')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'allowances.edit_during_review'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'allowances.reopen_approved'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

alter table public.allowance_entries add column if not exists manual_overrides jsonb not null default '{}'::jsonb;
alter table public.allowance_sheets add column if not exists reopened_at timestamptz;
alter table public.allowance_sheets add column if not exists reopened_by uuid references public.users(id) on delete set null;
alter table public.allowance_sheets add column if not exists reopen_reason text;

create table if not exists public.allowance_entry_adjustments (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    entry_id uuid not null references public.allowance_entries(id) on delete cascade,
    sheet_id uuid references public.allowance_sheets(id) on delete set null,
    user_id uuid not null references public.users(id) on delete cascade,
    field text not null,
    previous_value numeric not null,
    new_value numeric not null,
    reason text not null,
    actor_user_id uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create index if not exists allowance_entry_adjustments_entry_idx on public.allowance_entry_adjustments (entry_id);

alter table public.allowance_entry_adjustments enable row level security;
revoke all on public.allowance_entry_adjustments from anon, authenticated;
grant select on public.allowance_entry_adjustments to authenticated;
drop policy if exists "allowance adjustments visible to the employee or their reviewers" on public.allowance_entry_adjustments;
create policy "allowance adjustments visible to the employee or their reviewers" on public.allowance_entry_adjustments
for select to authenticated using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or public.current_prosm_time_user_is_owner()
        or (
            'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            and public.prosm_time_caller_has_authority_over(user_id)
        )
    )
);

-- The lines a manager may change, and their columns.
create or replace function public.prosm_time_allowance_line_column(p_field text)
returns text
language sql
immutable
set search_path = public
as $function$
    select case p_field
        when 'meal' then 'meal_allowance'
        when 'expatriation' then 'expatriation_allowance'
        when 'transportation' then 'transportation_allowance'
        when 'housing' then 'housing_allowance'
        when 'travel' then 'travel_allowance'
        when 'other' then 'other_allowance'
        when 'overtime' then 'overtime_amount'
        when 'extraDays' then 'extra_days_amount'
    end;
$function$;

-- A sheet's total always matches its days (an edit while it is reviewed).
create or replace function public.prosm_time_sync_allowance_sheet_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_sheet uuid := coalesce(new.sheet_id, old.sheet_id);
begin
    if v_sheet is not null then
        update allowance_sheets s
        set total = coalesce((select sum(public.prosm_time_entry_total(e)) from allowance_entries e where e.sheet_id = v_sheet), 0),
            days = (select count(*) from allowance_entries e where e.sheet_id = v_sheet)
        where s.id = v_sheet and s.status = 'submitted';
    end if;
    return null;
end;
$function$;

revoke all on function public.prosm_time_sync_allowance_sheet_total() from public, anon, authenticated;

drop trigger if exists allowance_entries_sync_sheet_total on public.allowance_entries;
create trigger allowance_entries_sync_sheet_total
after update on public.allowance_entries
for each row
when (old.* is distinct from new.*)
execute function public.prosm_time_sync_allowance_sheet_total();

-- Recalculation keeps the manager's values (same as 20261025130000, then the overrides).
create or replace function public.prosm_time_refresh_allowance_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_entry allowance_entries%rowtype;
    v_facts jsonb;
    v_rates jsonb;
    v_basis jsonb;
    v_key text;
    v_column text;
    v_value numeric;
begin
    select * into v_entry from allowance_entries where id = p_entry_id for update;
    if v_entry.id is null or v_entry.status = 'approved' then return; end if;

    v_facts := public.prosm_time_allowance_day_facts(v_entry.user_id, v_entry.entry_date);
    v_rates := v_facts -> 'rates';
    v_basis := public.prosm_time_allowance_basis(v_entry.organization_id);

    update allowance_entries set
        attendance_session_id = coalesce((v_facts ->> 'sessionId')::uuid, attendance_session_id),
        worked_minutes = (v_facts ->> 'workedMinutes')::numeric,
        overtime_minutes = (v_facts ->> 'overtimeMinutes')::numeric,
        overtime_hours = (v_facts ->> 'overtimeMinutes')::numeric / 60,
        overtime_days = (v_facts ->> 'extraDays')::numeric,
        day_type = v_facts ->> 'dayType',
        overtime_amount = round((v_facts ->> 'overtimeMinutes')::numeric * coalesce((v_rates ->> 'overtimeHour')::numeric, 0) / 60, 2),
        extra_days_amount = round((v_facts ->> 'extraDays')::numeric * coalesce((v_rates ->> 'extraDay')::numeric, 0), 2),
        updated_at = now()
    where id = p_entry_id;

    foreach v_key in array array['meal', 'expatriation', 'transportation', 'housing', 'travel', 'other'] loop
        if v_basis ->> v_key in ('per_hour', 'per_extra_day') then
            v_column := v_key || '_allowance';
            v_value := round(public.prosm_time_allowance_amount(v_basis ->> v_key, (v_rates ->> v_key)::numeric, v_facts), 2);
            execute format('update allowance_entries set %I = $1 where id = $2', v_column) using v_value, p_entry_id;
        end if;
    end loop;

    for v_key in select jsonb_object_keys(v_entry.manual_overrides) loop
        v_column := public.prosm_time_allowance_line_column(v_key);
        if v_column is not null then
            execute format('update allowance_entries set %I = $1 where id = $2', v_column)
            using (v_entry.manual_overrides -> v_key ->> 'value')::numeric, p_entry_id;
        end if;
    end loop;
end;
$function$;

-- The manager changes one line of a day in a sheet being reviewed.
create or replace function public.adjust_prosm_time_allowance_entry(p_entry_id uuid, p_field text, p_value numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_entry allowance_entries%rowtype;
    v_sheet allowance_sheets%rowtype;
    v_column text := public.prosm_time_allowance_line_column(p_field);
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_before numeric;
    v_original numeric;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if v_column is null then raise exception 'INVALID ALLOWANCE'; end if;
    if p_value is null or p_value < 0 then raise exception 'AN ALLOWANCE CANNOT BE NEGATIVE'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;

    select * into v_entry from allowance_entries where id = p_entry_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_entry.id is null then raise exception 'ALLOWANCE ENTRY NOT FOUND'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'allowances.edit_during_review') then
        raise exception 'ALLOWANCES.EDIT_DURING_REVIEW AUTHORITY REQUIRED';
    end if;
    if v_entry.user_id = v_caller then raise exception 'YOU CANNOT EDIT YOUR OWN ALLOWANCES IN REVIEW'; end if;
    if not public.prosm_time_caller_has_authority_over(v_entry.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if v_entry.status = 'approved' then raise exception 'THIS ALLOWANCE ENTRY IS ALREADY APPROVED'; end if;
    if v_entry.status <> 'submitted' or v_entry.sheet_id is null then raise exception 'THIS ALLOWANCE ENTRY IS NOT IN REVIEW'; end if;
    select * into v_sheet from allowance_sheets where id = v_entry.sheet_id;
    if v_sheet.status <> 'submitted' then raise exception 'THIS ALLOWANCE SHEET IS NOT AWAITING APPROVAL'; end if;

    execute format('select %I from allowance_entries where id = $1', v_column) into v_before using p_entry_id;
    v_original := coalesce((v_entry.manual_overrides -> p_field ->> 'original')::numeric, v_before);
    p_value := round(p_value, 2);

    update allowance_entries
    set manual_overrides = case
            when p_value = v_original then manual_overrides - p_field
            else manual_overrides || jsonb_build_object(p_field, jsonb_build_object('value', p_value, 'original', v_original, 'by', v_caller, 'at', now(), 'reason', v_reason))
        end,
        updated_at = now()
    where id = p_entry_id;
    execute format('update allowance_entries set %I = $1 where id = $2', v_column) using p_value, p_entry_id;

    insert into allowance_entry_adjustments (organization_id, entry_id, sheet_id, user_id, field, previous_value, new_value, reason, actor_user_id)
    values (v_entry.organization_id, p_entry_id, v_entry.sheet_id, v_entry.user_id, p_field, v_before, p_value, v_reason, v_caller);

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state, context)
    values (v_entry.organization_id, v_caller, v_entry.user_id, 'allowances.edit_during_review', 'allowance_entries', p_entry_id,
            'Allowance line changed during review', v_reason,
            jsonb_build_object('field', p_field, 'value', v_before),
            jsonb_build_object('field', p_field, 'value', p_value),
            jsonb_build_object('sheetId', v_entry.sheet_id, 'sheetStatus', v_sheet.status, 'entryDate', v_entry.entry_date, 'computedValue', v_original));

    return jsonb_build_object('success', true, 'total', (select total from allowance_sheets where id = v_entry.sheet_id));
end;
$function$;

revoke all on function public.adjust_prosm_time_allowance_entry(uuid, text, numeric, text) from public, anon;
grant execute on function public.adjust_prosm_time_allowance_entry(uuid, text, numeric, text) to authenticated;

-- An approved sheet goes back to review (and only so) to be corrected.
create or replace function public.reopen_prosm_time_allowance_sheet(p_sheet_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_sheet allowance_sheets%rowtype;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    select * into v_sheet from allowance_sheets where id = p_sheet_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_sheet.id is null then raise exception 'ALLOWANCE SHEET NOT FOUND'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'allowances.reopen_approved') then
        raise exception 'ALLOWANCES.REOPEN_APPROVED AUTHORITY REQUIRED';
    end if;
    if not public.prosm_time_caller_has_authority_over(v_sheet.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if v_sheet.status <> 'approved' then raise exception 'ONLY AN APPROVED SHEET CAN BE REOPENED'; end if;

    update allowance_sheets set status = 'submitted', reopened_at = now(), reopened_by = v_caller, reopen_reason = v_reason where id = p_sheet_id;
    update allowance_entries set status = 'submitted', approved_by = null, approved_at = null, updated_at = now() where sheet_id = p_sheet_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_sheet.organization_id, v_caller, v_sheet.user_id, 'allowances.reopen_approved', 'allowance_sheets', p_sheet_id,
            'Approved allowance sheet reopened for correction', v_reason,
            jsonb_build_object('status', 'approved', 'total', v_sheet.total, 'approvedBy', v_sheet.reviewed_by, 'approvedAt', v_sheet.reviewed_at),
            jsonb_build_object('status', 'submitted'));

    perform public.create_prosm_time_notification(
        v_sheet.organization_id, v_sheet.user_id, 'allowance_rejected', 'normal', 'Your allowances were reopened',
        'Your approved allowances for ' || v_sheet.period_start || ' - ' || v_sheet.period_end || ' are being corrected.',
        'allowance_sheets', p_sheet_id,
        jsonb_build_object('days', v_sheet.days, 'periodStart', v_sheet.period_start, 'periodEnd', v_sheet.period_end, 'notes', v_reason, 'reopened', true)
    );
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.reopen_prosm_time_allowance_sheet(uuid, text) from public, anon;
grant execute on function public.reopen_prosm_time_allowance_sheet(uuid, text) to authenticated;

commit;
