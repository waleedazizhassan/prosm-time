-- 2026-11-01 (plan stage 4.8): declining an allowance sheet or entry needs a reason,
-- which reaches the employee with the sheet returned for editing. The rest of the
-- cycle (rejected, edited back to draft, sent again, audited) already exists.
-- Rollback: restore both functions from their earlier migrations.

begin;

CREATE OR REPLACE FUNCTION public.review_prosm_time_allowance_sheet(p_sheet_id uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_sheet allowance_sheets%rowtype;
    v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_action not in ('approved', 'rejected') then raise exception 'INVALID ACTION'; end if;
    if p_action = 'rejected' and nullif(trim(coalesce(p_notes, '')), '') is null then
        raise exception 'A REASON IS REQUIRED TO REJECT';
    end if;

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

CREATE OR REPLACE FUNCTION public.approve_prosm_time_allowance_entry(p_entry_id uuid, p_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_entry allowance_entries%rowtype;
    v_site_id uuid;
    v_notes text;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_action not in ('approved', 'rejected') then
        raise exception 'INVALID ACTION';
    end if;
    if p_action = 'rejected' and nullif(trim(coalesce(p_notes, '')), '') is null then
        raise exception 'A REASON IS REQUIRED TO REJECT';
    end if;

    select * into v_entry from allowance_entries where id = p_entry_id and organization_id = v_caller_org;
    if v_entry.id is null then
        raise exception 'ALLOWANCE ENTRY NOT FOUND';
    end if;

    if v_entry.sheet_id is not null then
        raise exception 'REVIEW THE WHOLE ALLOWANCE SHEET';
    end if;

    if v_entry.status <> 'submitted' then
        raise exception 'THIS ALLOWANCE ENTRY IS NOT AWAITING APPROVAL';
    end if;

    -- The day's shift decides the site (the site responsible for it when it
    -- was clocked in away from a site); with no shift, the person's sites.
    select coalesce(ats.site_id, ats.responsible_site_id) into v_site_id
    from attendance_sessions ats where ats.id = v_entry.attendance_session_id;

    if not (
        public.current_prosm_time_user_is_owner()
        or (
            public.prosm_time_user_has_permission_internal(v_caller_id, 'allowances.approve')
            and public.prosm_time_caller_has_authority_over(v_entry.user_id, v_site_id)
        )
    ) then
        raise exception 'ALLOWANCES.APPROVE AUTHORITY REQUIRED FOR THIS EMPLOYEE';
    end if;

    v_notes := nullif(trim(coalesce(p_notes, '')), '');

    if p_action = 'approved' then
        update allowance_entries
        set status = 'approved', approved_by = v_caller_id, approved_at = now(),
            reviewed_by = v_caller_id, reviewed_at = now(), review_notes = v_notes, updated_at = now()
        where id = p_entry_id;
    else
        -- Rejected stays rejected (with the reason) until the employee edits or resubmits it.
        update allowance_entries
        set status = 'rejected', reviewed_by = v_caller_id, reviewed_at = now(), review_notes = v_notes, updated_at = now()
        where id = p_entry_id;
    end if;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason)
    values (
        v_caller_org, v_caller_id, v_entry.user_id, 'ALLOWANCE_ENTRY_' || upper(p_action), 'allowance_entries', p_entry_id,
        'Allowance entry for ' || v_entry.entry_date || ' ' || p_action || '.', v_notes
    );

    perform public.create_prosm_time_notification(
        v_caller_org, v_entry.user_id,
        case when p_action = 'approved' then 'allowance_approved' else 'allowance_rejected' end,
        'normal',
        case when p_action = 'approved' then 'Allowances approved' else 'Allowances rejected' end,
        coalesce(v_notes, 'Your allowances for ' || v_entry.entry_date || ' were ' || p_action || '.'),
        'allowance_entries', p_entry_id,
        jsonb_build_object('entryDate', v_entry.entry_date)
            || case when v_notes is not null then jsonb_build_object('notes', v_notes) else '{}'::jsonb end
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'APPROVE PROSM TIME ALLOWANCE ENTRY FAILED: %', sqlerrm;
end;
$function$;

commit;
