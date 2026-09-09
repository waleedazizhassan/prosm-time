-- PROSM Time - self-contained, self-cleaning verification of the new
-- external-workforce kiosk system. Net schema effect: zero.

begin;

do $verify$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_owner uuid := '24961637-458b-4df4-9549-508402a084b6';
    v_owner_auth_id uuid;
    v_site uuid;
    v_result jsonb;
    v_worker_id uuid;
    v_entry_id uuid;
    v_count int;
    v_rejected boolean;
begin
    select auth_user_id into v_owner_auth_id from users where id = v_owner;
    perform set_config('request.jwt.claim.sub', v_owner_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_auth_id, 'role', 'authenticated')::text, true);

    select id into v_site from sites where organization_id = v_org limit 1;
    if v_site is null then
        insert into sites (organization_id, name, latitude, longitude, allowed_radius_meters)
        values (v_org, 'Worker Verify Temp Site', 30.0444, 31.2357, 100)
        returning id into v_site;
    end if;

    -- 1) create a real site worker
    v_result := create_prosm_time_site_worker(v_site, 'Verify Worker', '778899');
    if (v_result->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: could not create site worker: %', v_result;
    end if;
    v_worker_id := (v_result->>'workerId')::uuid;

    -- 2) duplicate number rejected
    begin
        perform create_prosm_time_site_worker(v_site, 'Duplicate Number', '778899');
        raise exception 'VERIFY FAILED: duplicate worker number was NOT rejected';
    exception
        when others then
            if sqlerrm not ilike '%ALREADY IN USE%' then raise exception 'VERIFY FAILED: wrong duplicate error: %', sqlerrm; end if;
    end;

    -- 3) bad format rejected
    begin
        perform create_prosm_time_site_worker(v_site, 'Bad Format', '12');
        raise exception 'VERIFY FAILED: a non-6-digit number was NOT rejected';
    exception
        when others then
            if sqlerrm not ilike '%6 DIGITS%' then raise exception 'VERIFY FAILED: wrong format error: %', sqlerrm; end if;
    end;

    -- 4) clock in with real GPS sample
    v_result := kiosk_worker_clock_in(v_site, '778899', 30.0444, 31.2357);
    if (v_result->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: clock-in failed: %', v_result;
    end if;
    v_entry_id := (v_result->>'entryId')::uuid;

    -- 5) missing GPS rejected
    begin
        perform kiosk_worker_clock_in(v_site, '778899', null, null);
        raise exception 'VERIFY FAILED: missing GPS was NOT rejected on clock-in';
    exception
        when others then
            if sqlerrm not ilike '%GPS SAMPLE%' then raise exception 'VERIFY FAILED: wrong GPS error: %', sqlerrm; end if;
    end;

    -- 6) double clock-in rejected
    begin
        perform kiosk_worker_clock_in(v_site, '778899', 30.0444, 31.2357);
        raise exception 'VERIFY FAILED: double clock-in was NOT rejected';
    exception
        when others then
            if sqlerrm not ilike '%ALREADY CLOCKED IN%' then raise exception 'VERIFY FAILED: wrong double-clock-in error: %', sqlerrm; end if;
    end;

    -- 7) list shows the open entry
    select count(*) into v_count from list_prosm_time_site_worker_attendance(v_site, null, null) where id = v_entry_id;
    if v_count <> 1 then raise exception 'VERIFY FAILED: entry not found in list'; end if;

    -- 8) clock out with real GPS
    v_result := kiosk_worker_clock_out(v_site, '778899', 30.0445, 31.2358);
    if (v_result->>'success')::boolean is not true then
        raise exception 'VERIFY FAILED: clock-out failed: %', v_result;
    end if;

    -- 9) clock-out again rejected (not clocked in)
    begin
        perform kiosk_worker_clock_out(v_site, '778899', 30.0445, 31.2358);
        raise exception 'VERIFY FAILED: clock-out while not clocked in was NOT rejected';
    exception
        when others then
            if sqlerrm not ilike '%NOT CURRENTLY CLOCKED IN%' then raise exception 'VERIFY FAILED: wrong not-clocked-in error: %', sqlerrm; end if;
    end;

    -- 10) export RPC (service-role shape, called directly here) returns the entry
    select count(*) into v_count from list_prosm_time_worker_attendance_export(v_org, now() - interval '1 hour', now() + interval '1 hour') where entry_id = v_entry_id;
    if v_count <> 1 then raise exception 'VERIFY FAILED: entry not found in export RPC'; end if;

    -- 11) list_prosm_time_site_workers shows it
    select count(*) into v_count from list_prosm_time_site_workers(v_site) where id = v_worker_id;
    if v_count <> 1 then raise exception 'VERIFY FAILED: worker not found in site workers list'; end if;

    -- 12) deactivate
    v_result := deactivate_prosm_time_site_worker(v_worker_id);
    if (v_result->>'success')::boolean is not true then raise exception 'VERIFY FAILED: deactivate failed: %', v_result; end if;

    -- 13) inactive worker cannot clock in
    begin
        perform kiosk_worker_clock_in(v_site, '778899', 30.0444, 31.2357);
        raise exception 'VERIFY FAILED: inactive worker was able to clock in';
    exception
        when others then
            if sqlerrm not ilike '%NOT ACTIVE%' then raise exception 'VERIFY FAILED: wrong inactive-worker error: %', sqlerrm; end if;
    end;

    -- cleanup
    delete from site_worker_attendance where site_worker_id = v_worker_id;
    delete from site_workers where id = v_worker_id;
    if v_site is not null then
        delete from sites where id = v_site and name = 'Worker Verify Temp Site';
    end if;

    raise notice 'SITE WORKER KIOSK VERIFICATION PASSED';
end;
$verify$;

commit;
