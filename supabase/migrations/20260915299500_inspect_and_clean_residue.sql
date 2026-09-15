-- PROSM Time - inspect the 2 unexpected admin_on_behalf_actions rows
-- and 2 unexpected site_assignments rows the residue check surfaced,
-- then remove them if they are confirmed sweep leftovers (reason/
-- device_identifier text will say "QA"/"sweep"/"retest").
do $inspect$
declare
    v_row record;
begin
    for v_row in select id, actor_user_id, subject_user_id, action_type, session_id, event_id, reason, created_at
        from admin_on_behalf_actions where organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0' order by created_at
    loop
        raise notice 'ADMIN_ACTION id=% type=% session=% event=% reason=% created=%',
            v_row.id, v_row.action_type, v_row.session_id, v_row.event_id, v_row.reason, v_row.created_at;
    end loop;

    for v_row in select sa.id, sa.site_id, sa.user_id, sa.role_at_site, u.full_name
        from site_assignments sa join users u on u.id = sa.user_id
        where u.organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0'
    loop
        raise notice 'SITE_ASSIGNMENT id=% site=% user=%(%) role=%', v_row.id, v_row.site_id, v_row.full_name, v_row.user_id, v_row.role_at_site;
    end loop;
end;
$inspect$;
