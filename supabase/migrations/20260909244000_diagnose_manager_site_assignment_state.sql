-- PROSM Time - continuing the notification-routing investigation
-- (20260909242000 found the notify function's own loop logic; this
-- checks the actual underlying site_assignments data for the real
-- test-manager account to find why it didn't match).

begin;

do $diagnose$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_manager_user_id uuid;
    v_row record;
begin
    select id into v_manager_user_id from users where email = 'test-manager@prosm.net' and organization_id = v_org;
    raise notice 'test-manager user_id: %', v_manager_user_id;

    for v_row in
        select sa.site_id, s.name as site_name, sa.role_at_site
        from site_assignments sa
        join sites s on s.id = sa.site_id
        where sa.user_id = v_manager_user_id
    loop
        raise notice 'site_assignment: site=% (%) role_at_site=%', v_row.site_name, v_row.site_id, v_row.role_at_site;
    end loop;

    raise notice 'total site_assignments rows for org: %', (select count(*) from site_assignments sa join users u on u.id = sa.user_id where u.organization_id = v_org);
end;
$diagnose$;

commit;
