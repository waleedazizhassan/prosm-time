-- 2026-11-01 (plan stage 4.8): a sheet sent again after a rejection is marked, with
-- its revision and the total it had, for the manager reviewing it.
-- Rollback: restore the function and drop both columns.

begin;

alter table public.allowance_sheets
    add column revision integer not null default 1,
    add column previous_total numeric(14, 2);

CREATE OR REPLACE FUNCTION public.submit_prosm_time_allowances(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_previous allowance_sheets%rowtype;
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

    -- plan stage 4.8: sent again after a rejection, it says so, with the earlier total
    select * into v_previous from allowance_sheets
    where user_id = v_caller and status = 'rejected' and period_start <= v_last and period_end >= v_first
    order by submitted_at desc limit 1;

    insert into allowance_sheets (organization_id, user_id, period_start, period_end, days, total, revision, previous_total)
    values (v_org, v_caller, v_first, v_last, v_days, v_total, coalesce(v_previous.revision, 0) + 1, v_previous.total)
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

commit;
