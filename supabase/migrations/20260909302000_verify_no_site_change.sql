-- PROSM Time - self-contained, self-cleaning verification of the
-- mid-shift "change to no site" path (20260909300000/301000). Net
-- schema effect: zero.

begin;

do $verify$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth_id uuid;
    v_site uuid;
    v_session_id uuid;
    v_break_id uuid;
    v_result jsonb;
    v_session_site_id uuid;
    v_session_label text;
    v_conflict_raised boolean;
begin
    select auth_user_id into v_owner_auth_id from users where id = v_owner;
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    insert into sites (organization_id, name, latitude, longitude, allowed_radius_meters)
    values (v_org, 'No-Site-Change Verify Temp Site', 30.0444, 31.2357, 100)
    returning id into v_site;

    insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at)
    values (v_org, v_owner, v_site, 'clocked_in', now() - interval '1 hour')
    returning id into v_session_id;

    insert into break_events (organization_id, attendance_session_id, user_id, status, paid)
    values (v_org, v_session_id, v_owner, 'active', true)
    returning id into v_break_id;

    -- 1) missing manual label must be rejected
    begin
        perform change_prosm_time_site(v_break_id, null, 30.05, 31.24, 10, null);
        raise exception 'VERIFY FAILED: change to no-site with no label was accepted';
    exception
        when others then
            if sqlerrm not ilike '%WORKPLACE NAME IS REQUIRED%' then
                raise exception 'VERIFY FAILED: wrong error for missing label: %', sqlerrm;
            end if;
    end;

    -- 2) missing GPS sample must be rejected even with a label
    begin
        perform change_prosm_time_site(v_break_id, null, null, null, null, 'Client site B');
        raise exception 'VERIFY FAILED: change to no-site with no GPS sample was accepted';
    exception
        when others then
            if sqlerrm not ilike '%LOCATION SAMPLE IS REQUIRED%' then
                raise exception 'VERIFY FAILED: wrong error for missing GPS: %', sqlerrm;
            end if;
    end;

    -- 3) real change to no-site with label + GPS sample succeeds
    v_result := change_prosm_time_site(v_break_id, null, 30.05, 31.24, 12, 'Client site B - no registered site');
    if (v_result->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: valid no-site change was rejected: %', v_result;
    end if;
    if v_result->>'newSiteId' is not null then
        raise exception 'VERIFY FAILED: newSiteId should be null in the response: %', v_result;
    end if;

    select site_id, manual_location_label into v_session_site_id, v_session_label from attendance_sessions where id = v_session_id;
    if v_session_site_id is not null then
        raise exception 'VERIFY FAILED: attendance_sessions.site_id was not cleared to null';
    end if;
    if v_session_label <> 'Client site B - no registered site' then
        raise exception 'VERIFY FAILED: manual_location_label was not stored correctly: %', v_session_label;
    end if;

    if not exists (
        select 1 from site_change_events
        where attendance_session_id = v_session_id and new_site_id is null
          and manual_location_label = 'Client site B - no registered site'
          and latitude = 30.05 and longitude = 31.24
    ) then
        raise exception 'VERIFY FAILED: site_change_events row was not recorded correctly';
    end if;

    -- 4) changing to no-site again (already no-site) must be rejected
    insert into break_events (organization_id, attendance_session_id, user_id, status, paid)
    values (v_org, v_session_id, v_owner, 'active', true)
    returning id into v_break_id;
    begin
        perform change_prosm_time_site(v_break_id, null, 30.05, 31.24, 12, 'Another label');
        raise exception 'VERIFY FAILED: changing to no-site while already no-site was accepted';
    exception
        when others then
            if sqlerrm not ilike '%ALREADY WORKING WITHOUT A REGISTERED SITE%' then
                raise exception 'VERIFY FAILED: wrong error for already-no-site: %', sqlerrm;
            end if;
    end;

    -- cleanup
    delete from site_change_events where attendance_session_id = v_session_id;
    delete from break_events where attendance_session_id = v_session_id;
    delete from attendance_sessions where id = v_session_id;
    delete from sites where id = v_site;

    raise notice 'NO-SITE CHANGE VERIFICATION PASSED';
end;
$verify$;

commit;
