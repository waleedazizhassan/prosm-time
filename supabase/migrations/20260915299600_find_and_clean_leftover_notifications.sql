-- PROSM Time - find the 3 leftover notifications the residue check
-- surfaced (59 baseline -> 62 post-sweep) and remove them if they are
-- confirmed sweep artifacts (created during today's test run, for the
-- QA test accounts).
do $find$
declare
    v_row record;
begin
    for v_row in
        select id, type, user_id, related_entity_id, title, created_at
        from notifications
        where organization_id = 'cef9fc27-343d-4194-8167-033d1823b3d0'
          and created_at >= current_date
        order by created_at
    loop
        raise notice 'NOTIF id=% type=% user=% related=% title=% created=%',
            v_row.id, v_row.type, v_row.user_id, v_row.related_entity_id, v_row.title, v_row.created_at;
    end loop;
end;
$find$;
