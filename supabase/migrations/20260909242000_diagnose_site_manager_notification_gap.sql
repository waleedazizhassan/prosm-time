-- PROSM Time - diagnostic-only (self-cleaning): investigating why
-- notify_prosm_time_site_managers_or_owner's own site-manager loop
-- didn't reach a real, confirmed site manager during live testing of
-- 20260909241000's fix.

begin;

do $diagnose$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_site uuid := '24d343a2-fd14-4546-880f-e9dcc4279672';
    v_manager uuid := '92ce963c-1bd6-475a-836b-41980f4c4396';
    v_count int;
begin
    select count(*) into v_count
    from users u
    join site_assignments sa on sa.user_id = u.id
    where u.organization_id = v_org
    and sa.site_id = v_site
    and sa.role_at_site = 'manager';

    raise notice 'DIRECT QUERY MATCH COUNT: %', v_count;

    perform public.notify_prosm_time_site_managers_or_owner(
        v_org, v_site, 'exception_pending_review', 'normal', 'DIAGNOSTIC TITLE', 'DIAGNOSTIC BODY',
        'diagnostic', gen_random_uuid()
    );

    select count(*) into v_count from notifications where user_id = v_manager and title = 'DIAGNOSTIC TITLE';
    raise notice 'NOTIFICATION ACTUALLY INSERTED FOR MANAGER: %', v_count;

    delete from notifications where title = 'DIAGNOSTIC TITLE';
end;
$diagnose$;

commit;
