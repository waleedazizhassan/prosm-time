-- PROSM Time - re-running 20260909242000's own direct-call test now
-- that site_assignments is confirmed correct (role_at_site='manager'
-- for test-manager at QA Main Site) - isolating whether
-- create_prosm_time_notification itself is where the real problem is.

begin;

do $diagnose$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_site uuid := '24d343a2-fd14-4546-880f-e9dcc4279672';
    v_manager uuid := '92ce963c-1bd6-475a-836b-41980f4c4396';
    v_count int;
    v_test_id uuid := gen_random_uuid();
begin
    perform public.notify_prosm_time_site_managers_or_owner(
        v_org, v_site, 'exception_pending_review', 'normal', 'DIAGNOSTIC TITLE 2', 'DIAGNOSTIC BODY 2',
        'diagnostic', v_test_id
    );

    select count(*) into v_count from notifications where user_id = v_manager and title = 'DIAGNOSTIC TITLE 2';
    raise notice 'NOTIFICATION INSERTED FOR MANAGER (direct call): %', v_count;

    select count(*) into v_count from notifications where title = 'DIAGNOSTIC TITLE 2';
    raise notice 'NOTIFICATION INSERTED FOR ANYONE (direct call): %', v_count;

    delete from notifications where title = 'DIAGNOSTIC TITLE 2';
end;
$diagnose$;

commit;
