-- 2026-11-09 (owner): "in My payslips the employee asks for their payslip, the owner is told, opens it
-- from the notification and sends it - and it appears in My payslips. What was sent need not be kept
-- on the server, so we don't spend space."
-- A request can now be answered "in the app": nothing is generated or stored - the employee simply
-- may open that cycle's published payslip (already kept in the cycle's approved snapshot, as before)
-- and save it as PDF on their own device. The email answer stays as it was.
-- Rollback: drop column channel and send_prosm_time_payslip_in_app; restore get_my_prosm_time_payslip
-- and list_my_prosm_time_payslip_cycles from 20261108130000 / 20261108140000.

begin;

alter table public.payslip_requests add column if not exists channel text not null default 'email' check (channel in ('email', 'app'));

create or replace function public.send_prosm_time_payslip_in_app(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_request payslip_requests%rowtype;
    v_cycle payroll_cycles%rowtype;
    v_site uuid;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    perform public.prosm_time_require_feature('payroll');
    select * into v_request from payslip_requests where id = p_request_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_request.id is null then raise exception 'REQUEST NOT FOUND'; end if;
    select site_id into v_site from payroll_cycle_employees where cycle_id = v_request.cycle_id and user_id = v_request.user_id;
    if not public.prosm_time_payroll_allows('payroll.export_payslips', v_site) then raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips'; end if;
    if v_request.user_id = v_me then raise exception 'YOU CANNOT DECIDE YOUR OWN REQUEST'; end if;
    if v_request.status = 'sent' then raise exception 'THIS PAYSLIP WAS ALREADY SENT'; end if;
    select * into v_cycle from payroll_cycles where id = v_request.cycle_id;
    if v_cycle.status <> 'locked' or v_cycle.published_version is null then raise exception 'THIS PAYSLIP IS NOT PUBLISHED'; end if;

    update payslip_requests set status = 'sent', channel = 'app', sent_at = now(), handled_by = v_me,
        cycle_version = v_cycle.published_version, attempt_id = null, last_error = null, updated_at = now()
    where id = p_request_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (v_request.organization_id, v_me, v_request.user_id, 'payroll.payslip_sent_in_app', 'payslip_requests', p_request_id,
            'Payslip made available in the app', jsonb_build_object('cycleId', v_cycle.id, 'cycleTitle', v_cycle.title, 'cycleVersion', v_cycle.published_version));
    perform public.create_prosm_time_notification(v_request.organization_id, v_request.user_id, 'payslip_sent', 'normal',
        'Your payslip is ready', 'Your payslip of ' || v_cycle.title || ' is in My payslips.', 'payslip_requests', p_request_id,
        jsonb_build_object('cycleTitle', v_cycle.title, 'channel', 'app'));
    return jsonb_build_object('success', true, 'status', 'sent');
end;
$$;
revoke all on function public.send_prosm_time_payslip_in_app(uuid) from public, anon;
grant execute on function public.send_prosm_time_payslip_in_app(uuid) to authenticated;

do $patch$
declare
    v_def text;
    a1 text := '       or not exists (select 1 from payroll_settings where organization_id = v_cycle.organization_id and employee_self_service) then';
    a2 text := '                ''cycleVersion'', c.published_version, ''publishedAt'', c.published_at,';
begin
    v_def := pg_get_functiondef('public.get_my_prosm_time_payslip(uuid)'::regprocedure);
    if position(a1 in v_def) = 0 then raise exception 'get_my anchor not found'; end if;
    v_def := replace(v_def, a1, '       or (not exists (select 1 from payroll_settings where organization_id = v_cycle.organization_id and employee_self_service)
           and not exists (select 1 from payslip_requests r where r.user_id = v_me and r.cycle_id = p_cycle_id and r.status = ''sent'' and r.channel = ''app'')) then');
    execute v_def;

    v_def := pg_get_functiondef('public.list_my_prosm_time_payslip_cycles()'::regprocedure);
    if position(a2 in v_def) = 0 then raise exception 'list_my anchor not found'; end if;
    v_def := replace(v_def, a2, a2 || '
                ''canView'', coalesce(v_view, false) or exists (select 1 from payslip_requests r where r.user_id = v_me and r.cycle_id = c.id and r.status = ''sent'' and r.channel = ''app''),');
    execute v_def;
end;
$patch$;

commit;
