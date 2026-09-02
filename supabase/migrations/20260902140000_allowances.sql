-- PROSM Time - Feature 2 of the approved "Site Shift Policy +
-- Allowances" plan. A table: Date/Day/Site/Clock In/Clock Out
-- (read-only, imported from attendance) + Meal/Expatriation/
-- Transportation/Housing/Travel/Other allowances (employee-entered)
-- + Overtime hours/days (read-only, auto-computed from Feature 1's
-- shift policy - per the user's own confirmed choice). Mirrors
-- Timesheets' own draft -> submitted -> approved/rejected lifecycle
-- exactly, per the user's own explicit confirmation ("محتاجة اعتماد
-- زي كشوف الدوام بالظبط"). Deliberately site-scoped (unlike
-- Timesheets' own currently org-wide RLS) - this whole session has
-- been about closing exactly that gap everywhere else, and there is
-- no reason for a new feature to reopen it.

begin;

create table public.allowance_entries (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    attendance_session_id uuid references public.attendance_sessions(id) on delete set null,
    entry_date date not null,

    meal_allowance numeric(12, 2) not null default 0,
    expatriation_allowance numeric(12, 2) not null default 0,
    transportation_allowance numeric(12, 2) not null default 0,
    housing_allowance numeric(12, 2) not null default 0,
    travel_allowance numeric(12, 2) not null default 0,
    other_allowance numeric(12, 2) not null default 0,
    other_allowance_note text,

    -- Read-only, auto-computed by upsert_prosm_time_allowance_entry
    -- from that date's own shift-policy calculation (the same
    -- per-session formula generate_prosm_time_timesheet uses) - never
    -- accepted as direct client input.
    overtime_hours numeric(6, 2) not null default 0,
    overtime_days numeric(3, 1) not null default 0,

    status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at timestamptz,
    approved_by uuid references public.users(id) on delete set null,
    approved_at timestamptz,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    unique (user_id, entry_date)
);

create index allowance_entries_organization_id_idx on public.allowance_entries(organization_id);
create index allowance_entries_user_id_idx on public.allowance_entries(user_id);

alter table public.allowance_entries enable row level security;
revoke all on public.allowance_entries from anon, authenticated;

create policy "allowance entries visible to subject or allowances viewers"
on public.allowance_entries for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or (
                (
                    'allowances.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                    or 'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                )
                and (
                    (
                        attendance_session_id is not null
                        and exists (select 1 from attendance_sessions ats where ats.id = allowance_entries.attendance_session_id and ats.site_id = any(public.current_prosm_time_managed_site_ids()))
                    )
                    or (
                        attendance_session_id is null
                        and exists (select 1 from site_assignments sa where sa.user_id = allowance_entries.user_id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
                    )
                )
            )
        )
    )
);

-- ============================================================
-- Permission catalog - allowances.view / allowances.approve.
-- Owner gets both explicitly (the historical cross-join in WP-04
-- already ran once and won't pick up new rows); Manager gets both by
-- default too, mirroring how timesheets.approve was bundled to
-- Manager.
-- ============================================================

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('allowances.view', 'allowances', 'VIEW', 'View allowances', 'View employee allowance entries.'),
    ('allowances.approve', 'allowances', 'APPROVE', 'Approve allowances', 'Approve/reject employee allowance entries.');

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.role_key = 'owner' and p.permission_key in ('allowances.view', 'allowances.approve');

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.role_key = 'manager' and p.permission_key in ('allowances.view', 'allowances.approve');

-- ============================================================
-- upsert_prosm_time_allowance_entry - self-only, blocked once the
-- row leaves draft. Recomputes attendance_session_id and the two
-- read-only overtime columns from live attendance data every call,
-- so a draft always reflects the latest clock-in/out for that date.
-- ============================================================

create function public.upsert_prosm_time_allowance_entry(
    p_entry_date date,
    p_meal_allowance numeric default 0,
    p_expatriation_allowance numeric default 0,
    p_transportation_allowance numeric default 0,
    p_housing_allowance numeric default 0,
    p_travel_allowance numeric default 0,
    p_other_allowance numeric default 0,
    p_other_allowance_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_existing_status text;
    v_session_id uuid;
    v_overtime_minutes double precision := 0;
    v_entry_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_entry_date is null then
        raise exception 'ENTRY DATE IS REQUIRED';
    end if;

    select status into v_existing_status from allowance_entries where user_id = v_caller_id and entry_date = p_entry_date;
    if v_existing_status is not null and v_existing_status <> 'draft' then
        raise exception 'THIS ALLOWANCE ENTRY HAS ALREADY BEEN SUBMITTED - EDITING IS ONLY ALLOWED WHILE IN DRAFT';
    end if;

    select ats.id into v_session_id
    from attendance_sessions ats
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date
    order by ats.clock_in_at desc
    limit 1;

    -- Same per-session shift-policy formula generate_prosm_time_timesheet
    -- uses (20260902130000) - a site with no overtime_start_time
    -- configured contributes 0 here, matching that migration's own
    -- "unconfigured site = no shift-based overtime" behavior.
    select coalesce(sum(
        case
            when s.overtime_start_time is not null and ats.clock_out_at is not null then
                greatest(extract(epoch from ((ats.clock_out_at at time zone s.timezone)::time - s.overtime_start_time)) / 60, 0)
            else 0
        end
    ), 0)
    into v_overtime_minutes
    from attendance_sessions ats
    left join sites s on s.id = ats.site_id
    where ats.user_id = v_caller_id and ats.clock_in_at::date = p_entry_date;

    insert into allowance_entries (
        organization_id, user_id, attendance_session_id, entry_date,
        meal_allowance, expatriation_allowance, transportation_allowance,
        housing_allowance, travel_allowance, other_allowance, other_allowance_note,
        overtime_hours, overtime_days, status, updated_at
    ) values (
        v_caller_org, v_caller_id, v_session_id, p_entry_date,
        coalesce(p_meal_allowance, 0), coalesce(p_expatriation_allowance, 0), coalesce(p_transportation_allowance, 0),
        coalesce(p_housing_allowance, 0), coalesce(p_travel_allowance, 0), coalesce(p_other_allowance, 0), p_other_allowance_note,
        round((v_overtime_minutes / 60)::numeric, 2), case when v_overtime_minutes > 0 then 1 else 0 end, 'draft', now()
    )
    on conflict (user_id, entry_date) do update set
        meal_allowance = excluded.meal_allowance,
        expatriation_allowance = excluded.expatriation_allowance,
        transportation_allowance = excluded.transportation_allowance,
        housing_allowance = excluded.housing_allowance,
        travel_allowance = excluded.travel_allowance,
        other_allowance = excluded.other_allowance,
        other_allowance_note = excluded.other_allowance_note,
        attendance_session_id = excluded.attendance_session_id,
        overtime_hours = excluded.overtime_hours,
        overtime_days = excluded.overtime_days,
        updated_at = now()
    returning id into v_entry_id;

    return jsonb_build_object('success', true, 'entryId', v_entry_id);
exception
    when others then
        raise exception 'UPSERT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.upsert_prosm_time_allowance_entry(date, numeric, numeric, numeric, numeric, numeric, numeric, text) to authenticated;

-- ============================================================
-- submit_prosm_time_allowance_entry - self-only, draft -> submitted.
-- ============================================================

create function public.submit_prosm_time_allowance_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_entry allowance_entries%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    select * into v_entry from allowance_entries where id = p_entry_id;
    if v_entry.id is null then
        raise exception 'ALLOWANCE ENTRY NOT FOUND';
    end if;

    if v_entry.user_id <> v_caller_id then
        raise exception 'YOU MAY ONLY SUBMIT YOUR OWN ALLOWANCE ENTRY';
    end if;

    if v_entry.status <> 'draft' then
        raise exception 'THIS ALLOWANCE ENTRY IS NOT IN DRAFT STATUS';
    end if;

    update allowance_entries set status = 'submitted', submitted_at = now(), updated_at = now() where id = p_entry_id;

    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description)
    values (v_entry.organization_id, v_caller_id, 'ALLOWANCE_ENTRY_SUBMITTED', 'allowance_entries', p_entry_id, 'Allowance entry for ' || v_entry.entry_date || ' submitted.');

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'SUBMIT PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.submit_prosm_time_allowance_entry(uuid) from public, anon;
grant execute on function public.submit_prosm_time_allowance_entry(uuid) to authenticated;

-- ============================================================
-- approve_prosm_time_allowance_entry - Owner or a site-scoped
-- allowances.approve holder (same managed-site check as the RLS
-- policy above, including its no-session fallback to the employee's
-- own site assignments).
-- ============================================================

create function public.approve_prosm_time_allowance_entry(
    p_entry_id uuid,
    p_action text,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_entry allowance_entries%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;

    select * into v_entry from allowance_entries where id = p_entry_id and organization_id = v_caller_org;
    if v_entry.id is null then
        raise exception 'ALLOWANCE ENTRY NOT FOUND';
    end if;

    if v_entry.status <> 'submitted' then
        raise exception 'THIS ALLOWANCE ENTRY IS NOT AWAITING APPROVAL';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
            and (
                (
                    v_entry.attendance_session_id is not null
                    and exists (select 1 from attendance_sessions ats where ats.id = v_entry.attendance_session_id and ats.site_id = any(public.current_prosm_time_managed_site_ids()))
                )
                or (
                    v_entry.attendance_session_id is null
                    and exists (select 1 from site_assignments sa where sa.user_id = v_entry.user_id and sa.site_id = any(public.current_prosm_time_managed_site_ids()))
                )
            )
        )
    ) then
        raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED FOR THIS EMPLOYEE';
    end if;

    if p_action = 'approved' then
        update allowance_entries set status = 'approved', approved_by = v_caller_id, approved_at = now(), updated_at = now() where id = p_entry_id;
    else
        update allowance_entries set status = 'draft', submitted_at = null, updated_at = now() where id = p_entry_id;
    end if;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_entry.user_id, 'ALLOWANCE_ENTRY_' || upper(p_action), 'allowance_entries', p_entry_id,
        'Allowance entry for ' || v_entry.entry_date || ' ' || p_action || '.', p_notes
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'APPROVE PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

revoke all on function public.approve_prosm_time_allowance_entry(uuid, text, text) from public, anon;
grant execute on function public.approve_prosm_time_allowance_entry(uuid, text, text) to authenticated;

commit;
