-- PROSM Time - final retest: timesheet approval with the correct
-- action value ('approved'/'rejected', matching the real frontend's
-- own TS type and review_prosm_time_leave's identical convention -
-- the previous attempt used 'approve'/'reject' by mistake).
do $retest2$
declare
    v_owner_auth uuid := 'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc';
    v_employee_auth uuid := 'f8f8c181-fa33-457a-810e-0ad429a5efc6';
    v_employee uuid := '52c35a21-1d58-4cf4-80ba-fa206667d8d9';
    v_r jsonb;
    v_timesheet_a uuid;
begin
    perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
    v_r := public.generate_prosm_time_timesheet(v_employee, current_date - 7, current_date - 1);
    v_timesheet_a := (v_r->>'timesheetId')::uuid;
    perform set_config('request.jwt.claim.sub', v_employee_auth::text, true);
    perform public.submit_prosm_time_timesheet(v_timesheet_a);
    perform set_config('request.jwt.claim.sub', v_owner_auth::text, true);
    v_r := public.approve_prosm_time_timesheet(v_timesheet_a, 'approved', 'QA final retest approve');

    if (v_r->>'success')::boolean then
        raise notice 'PASS 9(final) timesheet generate(Owner)/submit/approve: status=%', (select status from timesheets where id = v_timesheet_a);
    else
        raise notice 'FAIL 9(final) timesheet: %', v_r;
    end if;

    delete from notifications where related_entity_id = v_timesheet_a;
    delete from timesheets where id = v_timesheet_a;
exception when others then
    raise notice 'FAIL 9(final) timesheet EXCEPTION: %', sqlerrm;
    if v_timesheet_a is not null then
        delete from notifications where related_entity_id = v_timesheet_a;
        delete from timesheets where id = v_timesheet_a;
    end if;
end;
$retest2$;
