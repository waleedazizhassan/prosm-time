-- Owner 2026-11-12 (review): "clocked in with an expired document" reached personnel managers on every
-- clock-in (a break, a second session, a site change). Now: once a day per person - the first clock-in of
-- the day tells them; the rest of the day it is already known. Blocking is unchanged.
-- Rollback: restore prosm_time_document_clock_in_check from 20261111210000_employee_documents.sql.

begin;

create or replace function public.prosm_time_document_clock_in_check(p_user_id uuid, p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_block text;
    v_warn text;
    v_name text;
    v_to uuid;
    v_tz text;
begin
    if not public.prosm_time_plan_allows(p_org, 'documents') then return null; end if;
    select string_agg(t.name, ', ') filter (where t.clock_in_rule = 'block'), string_agg(t.name, ', ') filter (where t.clock_in_rule = 'warn')
    into v_block, v_warn
    from employee_documents d join document_types t on t.id = d.document_type_id and t.is_active and t.is_mandatory
    where d.user_id = p_user_id and d.is_current and (d.status = 'expired' or (d.status in ('missing', 'rejected') and t.clock_in_rule = 'block'));
    if v_block is not null then raise exception 'DOCUMENT REQUIRED TO CLOCK IN: %', v_block; end if;
    if v_warn is not null then
        v_tz := public.prosm_time_site_timezone(public.prosm_time_calendar_site(p_user_id), p_org);
        -- once a day per person
        if not exists (
            select 1 from notifications n
            where n.organization_id = p_org and n.type = 'document_clock_in' and n.data ->> 'userId' = p_user_id::text
              and (n.created_at at time zone v_tz)::date = (now() at time zone v_tz)::date
        ) then
            select full_name into v_name from users where id = p_user_id;
            for v_to in select * from public.prosm_time_hr_people(p_org) loop
                perform public.create_prosm_time_notification(p_org, v_to, 'document_clock_in', 'high', 'Clocked in with an expired document',
                    coalesce(v_name, '') || ' clocked in with an expired document: ' || v_warn || '.', 'users', p_user_id,
                    jsonb_build_object('employeeName', v_name, 'documentName', v_warn, 'userId', p_user_id, 'kind', 'hr'));
            end loop;
        end if;
    end if;
    return v_warn;
end;
$$;
revoke all on function public.prosm_time_document_clock_in_check(uuid, uuid) from public, anon, authenticated;

commit;
