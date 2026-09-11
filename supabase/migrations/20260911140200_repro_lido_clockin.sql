-- Reproduce Lido's real clock-in attempt exactly (no-site walk-in,
-- manual label "G", Alexandria coordinates) as a real simulated
-- session, to isolate whether the RPC itself fails or the failure is
-- at the Edge Function layer.
do $$
declare
    v_result jsonb;
begin
    perform set_config('request.jwt.claim.sub', 'a0b5ee69-2921-4dcc-9ad1-0007d08d12bf', true);
    begin
        v_result := public.clock_in_prosm_time_attendance(
            p_idempotency_key => 'repro-test-' || gen_random_uuid()::text,
            p_site_id => null,
            p_latitude => 31.2001,
            p_longitude => 29.9187,
            p_accuracy_meters => 23,
            p_manual_location_label => 'G'
        );
        raise notice 'RESULT: %', v_result;
    exception when others then
        raise notice 'ERROR: %', sqlerrm;
    end;
    perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Clean up whatever the repro attempt created, if it succeeded.
delete from attendance_events where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246' and idempotency_key like 'repro-test-%';
delete from presence_sessions where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246' and started_at > now() - interval '1 minute';
delete from attendance_sessions where user_id = '347ea231-ad1e-4481-a633-dba1ed3c4246' and clock_in_at > now() - interval '1 minute';
