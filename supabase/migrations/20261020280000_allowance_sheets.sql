-- Owner 2026-10-20 ("submitting allowances is for all of them: every day with
-- one tap goes to the manager as one file, not day by day"). "Send to
-- manager" now makes one allowance sheet holding every unsent day; the
-- manager approves or rejects the sheet in one decision (one notification
-- each way), and the decision applies to all its days. A rejected sheet's
-- days go back to the employee to fix and send again.

begin;

create table public.allowance_sheets (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    period_start date not null,
    period_end date not null,
    days integer not null,
    total numeric(14, 2) not null,
    status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
    submitted_at timestamptz not null default now(),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text
);

create index allowance_sheets_organization_id_idx on public.allowance_sheets(organization_id);
alter table public.allowance_entries add column if not exists sheet_id uuid references public.allowance_sheets(id) on delete set null;

alter table public.allowance_sheets enable row level security;
revoke all on public.allowance_sheets from anon, authenticated;
grant select on public.allowance_sheets to authenticated;

-- The employee sees their sheets; a reviewer sees the sheets of those they can decide for.
create policy "allowance sheets visible to the employee or their reviewers"
on public.allowance_sheets for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (
        user_id = public.current_prosm_time_user_id()
        or (
            (public.current_prosm_time_user_is_owner()
             or 'allowances.approve' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[])))
            and public.prosm_time_caller_has_authority_over(user_id)
        )
    )
);

create or replace function public.prosm_time_entry_total(e allowance_entries)
returns numeric
language sql
immutable
as $function$
    select e.meal_allowance + e.expatriation_allowance + e.transportation_allowance + e.housing_allowance
         + e.travel_allowance + e.other_allowance + e.overtime_amount + e.extra_days_amount;
$function$;

revoke all on function public.prosm_time_entry_total(allowance_entries) from public, anon, authenticated;

-- Send every unsent day (draft or rejected) as one sheet.
create or replace function public.submit_prosm_time_allowances(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_sheet uuid;
    v_days integer;
    v_total numeric;
    v_first date;
    v_last date;
    v_name text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if public.current_prosm_time_user_is_owner() then raise exception 'THE OWNER HAS NO ALLOWANCES'; end if;

    select count(*), coalesce(sum(public.prosm_time_entry_total(e)), 0), min(entry_date), max(entry_date)
    into v_days, v_total, v_first, v_last
    from allowance_entries e
    where e.user_id = v_caller and e.status in ('draft', 'rejected') and e.entry_date between p_from and p_to;

    if v_days = 0 then raise exception 'NO ALLOWANCES TO SEND'; end if;

    insert into allowance_sheets (organization_id, user_id, period_start, period_end, days, total)
    values (v_org, v_caller, v_first, v_last, v_days, v_total)
    returning id into v_sheet;

    update allowance_entries
    set status = 'submitted', submitted_at = now(), sheet_id = v_sheet, updated_at = now()
    where user_id = v_caller and status in ('draft', 'rejected') and entry_date between p_from and p_to;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (v_org, v_caller, v_caller, 'ALLOWANCE_SHEET_SUBMITTED', 'allowance_sheets', v_sheet,
            'Allowance sheet of ' || v_days || ' days (' || v_first || ' - ' || v_last || ') submitted.');

    select full_name into v_name from users where id = v_caller;
    perform public.notify_prosm_time_approvers_of(
        v_caller, 'allowances.approve', 'allowance_submitted', 'normal',
        'Allowances waiting for approval',
        v_name || ' sent allowances for ' || v_days || ' days (' || v_first || ' - ' || v_last || ').',
        'allowance_sheets', v_sheet,
        jsonb_build_object('employeeName', v_name, 'days', v_days, 'periodStart', v_first, 'periodEnd', v_last, 'total', v_total)
    );

    return jsonb_build_object('success', true, 'sent', v_days, 'sheetId', v_sheet);
end;
$function$;

-- One decision for the whole sheet.
create or replace function public.review_prosm_time_allowance_sheet(p_sheet_id uuid, p_action text, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_sheet allowance_sheets%rowtype;
    v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;

    select * into v_sheet from allowance_sheets where id = p_sheet_id and organization_id = public.current_prosm_time_organization_id();
    if v_sheet.id is null then raise exception 'ALLOWANCE SHEET NOT FOUND'; end if;
    if v_sheet.status <> 'submitted' then raise exception 'THIS ALLOWANCE SHEET IS NOT AWAITING APPROVAL'; end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            public.prosm_time_user_has_permission_internal(v_caller, 'allowances.approve')
            and public.prosm_time_caller_has_authority_over(v_sheet.user_id)
        )
    ) then
        raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED FOR THIS EMPLOYEE';
    end if;

    update allowance_sheets set status = p_action, reviewed_by = v_caller, reviewed_at = now(), review_notes = v_notes where id = p_sheet_id;

    update allowance_entries
    set status = p_action,
        approved_by = case when p_action = 'approved' then v_caller else approved_by end,
        approved_at = case when p_action = 'approved' then now() else approved_at end,
        reviewed_by = v_caller, reviewed_at = now(), review_notes = v_notes, updated_at = now()
    where sheet_id = p_sheet_id and status = 'submitted';

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (v_sheet.organization_id, v_caller, v_sheet.user_id, 'ALLOWANCE_SHEET_' || upper(p_action), 'allowance_sheets', p_sheet_id,
            'Allowance sheet of ' || v_sheet.days || ' days ' || p_action || '.', v_notes);

    perform public.create_prosm_time_notification(
        v_sheet.organization_id, v_sheet.user_id,
        case when p_action = 'approved' then 'allowance_approved' else 'allowance_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Allowances approved' else 'Allowances rejected' end,
        coalesce(v_notes, 'Your allowances for ' || v_sheet.period_start || ' - ' || v_sheet.period_end || ' were ' || p_action || '.'),
        'allowance_sheets', p_sheet_id,
        jsonb_build_object('days', v_sheet.days, 'periodStart', v_sheet.period_start, 'periodEnd', v_sheet.period_end)
            || case when v_notes is not null then jsonb_build_object('notes', v_notes) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.review_prosm_time_allowance_sheet(uuid, text, text) from public, anon;
grant execute on function public.review_prosm_time_allowance_sheet(uuid, text, text) to authenticated;

-- A day that belongs to a sheet is decided with its sheet, never alone.
do $$
declare
    v_def text;
    v_anchor constant text := 'if v_entry.status <> ''submitted'' then';
begin
    v_def := pg_get_functiondef('public.approve_prosm_time_allowance_entry(uuid, text, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then
        raise exception 'approve_prosm_time_allowance_entry changed - status check not found';
    end if;
    v_def := replace(v_def, v_anchor,
        'if v_entry.sheet_id is not null then' || chr(10) ||
        '        raise exception ''REVIEW THE WHOLE ALLOWANCE SHEET'';' || chr(10) ||
        '    end if;' || chr(10) || chr(10) ||
        '    ' || v_anchor);
    execute v_def;
end;
$$;

-- The dashboard counts sheets waiting, not their days.
do $$
declare
    v_def text;
begin
    v_def := pg_get_functiondef('public.get_prosm_time_dashboard_summary(date, text)'::regprocedure);
    if position('select user_id from allowance_entries where organization_id = v_org and status = ''submitted''' in v_def) = 0 then
        raise exception 'get_prosm_time_dashboard_summary changed - allowance count not found';
    end if;
    v_def := replace(v_def,
        'select user_id from allowance_entries where organization_id = v_org and status = ''submitted''',
        'select user_id from allowance_sheets where organization_id = v_org and status = ''submitted''');
    execute v_def;
end;
$$;

commit;
