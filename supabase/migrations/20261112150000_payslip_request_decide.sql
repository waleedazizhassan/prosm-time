-- Owner 2026-11-12: "on the payslips page the employee has a clear 'request payslip' button; the request
-- reaches the person in charge on the manager page; one tap opens a card with a preview, send and reject.
-- Send reaches the employee by notification and email; reject sends a rejection notification." The email
-- answer (send-payslip-email) already notifies the employee. New here: a read-only preview of the
-- requested payslip for whoever may issue it, a reasoned rejection, and a payslip sent by email can be
-- opened in My payslips too.
-- Rollback: drop get_prosm_time_payslip_request_preview(uuid) and reject_prosm_time_payslip_request(uuid,
-- text); restore the status check (pending, sending, sent, failed); drop columns rejection_reason,
-- rejected_at; restore list_prosm_time_payslip_requests from 20261108140000 and the canView rule of
-- get_my_prosm_time_payslip / list_my_prosm_time_payslip_cycles from 20261109330000.

begin;

alter table public.payslip_requests drop constraint if exists payslip_requests_status_check;
alter table public.payslip_requests add constraint payslip_requests_status_check check (status in ('pending', 'sending', 'sent', 'failed', 'rejected'));
alter table public.payslip_requests
    add column if not exists rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 300),
    add column if not exists rejected_at timestamptz;

-- a new notification type: the refusal
do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('payslip_rejected' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''payslip_rejected''::text');
        if position('payslip_rejected' in v_def) = 0 then raise exception 'notification type anchor not found'; end if;
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

-- The requested payslip, exactly as the employee would see it, for whoever may issue it.
create or replace function public.get_prosm_time_payslip_request_preview(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request payslip_requests%rowtype;
    v_cycle payroll_cycles%rowtype;
    v_site uuid;
    v_emp jsonb;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('payroll');
    select * into v_request from payslip_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id();
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    select site_id into v_site from payroll_cycle_employees where cycle_id = v_request.cycle_id and user_id = v_request.user_id;
    if not public.prosm_time_payroll_allows('payroll.export_payslips', v_site) then raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips'; end if;
    select * into v_cycle from payroll_cycles where id = v_request.cycle_id;
    if v_cycle.status <> 'locked' or v_cycle.published_version is null then raise exception 'THIS PAYSLIP IS NOT PUBLISHED'; end if;
    select e into v_emp from payroll_cycle_snapshots s, jsonb_array_elements(s.data -> 'employees') e
    where s.cycle_id = v_cycle.id and s.cycle_version = v_cycle.published_version and (e ->> 'user_id')::uuid = v_request.user_id;
    if v_emp is null then raise exception 'PAYSLIP NOT AVAILABLE'; end if;
    return jsonb_build_object(
        'cycle', jsonb_build_object('title', v_cycle.title, 'periodStart', v_cycle.period_start, 'periodEnd', v_cycle.period_end, 'cycleVersion', v_cycle.published_version),
        'organization', (select jsonb_build_object('name', name, 'logoUrl', logo_url) from organizations where id = v_cycle.organization_id),
        'settings', jsonb_build_object('taxNotice', v_cycle.policy_snapshot ->> 'tax_notice', 'footerNote', v_cycle.policy_snapshot ->> 'footer_note'),
        'employee', (v_emp - 'lines') || jsonb_build_object('lines', coalesce((
            select jsonb_agg(l order by (l ->> 'sort_order')::int) from jsonb_array_elements(v_emp -> 'lines') l
            where (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean), '[]'::jsonb)));
end;
$$;
revoke all on function public.get_prosm_time_payslip_request_preview(uuid) from public, anon;
grant execute on function public.get_prosm_time_payslip_request_preview(uuid) to authenticated;

-- Reject with a reason; the employee is told, and may ask again.
create or replace function public.reject_prosm_time_payslip_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request payslip_requests%rowtype;
    v_site uuid;
    v_title text;
    v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('payroll');
    if v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    select * into v_request from payslip_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    select site_id into v_site from payroll_cycle_employees where cycle_id = v_request.cycle_id and user_id = v_request.user_id;
    if not public.prosm_time_payroll_allows('payroll.export_payslips', v_site) then raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips'; end if;
    if v_request.user_id = v_me then raise exception 'YOU CANNOT DECIDE YOUR OWN REQUEST'; end if;
    if v_request.status = 'sent' then raise exception 'THIS PAYSLIP WAS ALREADY SENT'; end if;
    if v_request.status = 'rejected' then raise exception 'THIS REQUEST WAS ALREADY DECIDED'; end if;
    if v_request.status = 'sending' and v_request.sending_started_at > now() - interval '10 minutes' then raise exception 'THIS PAYSLIP IS BEING SENT'; end if;

    update payslip_requests set status = 'rejected', rejection_reason = left(v_reason, 300), rejected_at = now(), handled_by = v_me,
        attempt_id = null, updated_at = now()
    where id = p_request_id;
    select title into v_title from payroll_cycles where id = v_request.cycle_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (v_request.organization_id, v_me, v_request.user_id, 'payroll.payslip_request_rejected', 'payslip_requests', p_request_id,
            'Payslip request rejected', jsonb_build_object('cycleId', v_request.cycle_id, 'cycleTitle', v_title, 'reason', left(v_reason, 300)));
    perform public.create_prosm_time_notification(v_request.organization_id, v_request.user_id, 'payslip_rejected', 'normal',
        'Payslip request declined', 'Your request for the payslip of ' || coalesce(v_title, '') || ' was declined: ' || left(v_reason, 300),
        'payslip_requests', p_request_id, jsonb_build_object('cycleTitle', v_title, 'reason', left(v_reason, 300)));
    return jsonb_build_object('success', true, 'status', 'rejected');
end;
$$;
revoke all on function public.reject_prosm_time_payslip_request(uuid, text) from public, anon;
grant execute on function public.reject_prosm_time_payslip_request(uuid, text) to authenticated;

do $patch$
declare
    v_def text;
    a_list text := '''note'', r.note,';
    a_app text := 'r.status = ''sent'' and r.channel = ''app''';
    a_mine text := '''request'', (select jsonb_build_object(''id'', r.id,';
begin
    -- the manager's list carries the refusal
    v_def := replace(pg_get_functiondef('public.list_prosm_time_payslip_requests(text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(a_list in v_def) = 0 then raise exception 'payslip list anchor not found'; end if;
    v_def := replace(v_def, a_list, a_list || ' ''rejectionReason'', r.rejection_reason, ''rejectedAt'', r.rejected_at,');
    execute v_def;

    -- a payslip sent by email opens in My payslips too
    v_def := replace(pg_get_functiondef('public.get_my_prosm_time_payslip(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(a_app in v_def) = 0 then raise exception 'get_my sent anchor not found'; end if;
    v_def := replace(v_def, a_app, 'r.status = ''sent''');
    execute v_def;

    v_def := replace(pg_get_functiondef('public.list_my_prosm_time_payslip_cycles()'::regprocedure), chr(13) || chr(10), chr(10));
    if position(a_app in v_def) = 0 then raise exception 'list_my sent anchor not found'; end if;
    v_def := replace(v_def, a_app, 'r.status = ''sent''');
    -- the employee sees the refusal's reason
    if position(a_mine in v_def) = 0 then raise exception 'list_my request anchor not found'; end if;
    v_def := replace(v_def, a_mine, a_mine || ' ''reason'', r.rejection_reason,');
    execute v_def;
end;
$patch$;

commit;
