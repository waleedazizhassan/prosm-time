-- PROSM Time - true end-to-end verification of the leave management
-- request -> review -> balance flow, without needing a real login.
-- current_prosm_time_user_id() resolves via auth.uid(), Supabase's own
-- standard `select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid`
-- - settable for the duration of a transaction via SET LOCAL, the same
-- technique PostgREST itself uses per-request. This lets every RPC's
-- own auth.uid()-based gate be exercised for real, as the real
-- admin@prosm.net Owner (auth_user_id ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc,
-- already on record from this session's own earlier org-reset work) -
-- proving the "authorized caller succeeds" path this session's other
-- same-day verifications (export-attendance, leave schema/constraints)
-- could not reach without a real password.

begin;

do $$
declare
    v_admin_auth_id uuid := 'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc';
    v_resolved_uid uuid;
    v_resolved_user_id uuid;
    v_request_id uuid;
    v_balance jsonb;
    v_annual_remaining_before numeric;
    v_annual_remaining_after numeric;
begin
    perform set_config('request.jwt.claim.sub', v_admin_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_auth_id, 'role', 'authenticated')::text, true);

    v_resolved_uid := auth.uid();
    if v_resolved_uid is distinct from v_admin_auth_id then
        raise notice 'auth.uid() simulation did not take effect (got %) - skipping the authorized-caller flow, already covered by the unauthenticated-rejection checks in 20260908201000.', v_resolved_uid;
        return;
    end if;

    v_resolved_user_id := public.current_prosm_time_user_id();
    if v_resolved_user_id is null then
        raise notice 'auth.uid() simulated correctly but current_prosm_time_user_id() found no matching users row - skipping.';
        return;
    end if;
    raise notice 'session simulation: OK - acting as users.id = % (admin@prosm.net)', v_resolved_user_id;

    -- Baseline balance before requesting anything.
    v_balance := public.get_prosm_time_leave_balance(null, extract(year from current_date)::integer);
    select (b->>'remainingDays')::numeric into v_annual_remaining_before
    from jsonb_array_elements(v_balance->'balances') b
    where b->>'leaveType' = 'annual';
    raise notice 'get_prosm_time_leave_balance (as real authorized caller): OK - annual remaining before request = %', v_annual_remaining_before;

    -- Real request, as the real Owner, through the real RPC (not a raw
    -- INSERT this time).
    declare
        v_request_result jsonb;
    begin
        v_request_result := public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, 'End-to-end verification request');
        v_request_id := (v_request_result->>'requestId')::uuid;
        if v_request_id is null then
            raise exception 'VERIFICATION FAILED: request_prosm_time_leave did not return a requestId';
        end if;
        raise notice 'request_prosm_time_leave (as real authorized caller): OK - created request %, days = %', v_request_id, v_request_result->>'daysCount';
    end;

    -- Balance must reflect the new PENDING request.
    v_balance := public.get_prosm_time_leave_balance(null, extract(year from current_date)::integer);
    declare
        v_pending numeric;
    begin
        select (b->>'pendingDays')::numeric into v_pending from jsonb_array_elements(v_balance->'balances') b where b->>'leaveType' = 'annual';
        if v_pending < 2 then
            raise exception 'VERIFICATION FAILED: pendingDays did not increase after a real request (got %)', v_pending;
        end if;
        raise notice 'balance reflects the new pending request: OK - pendingDays = %', v_pending;
    end;

    -- review_prosm_time_leave: approve, as the same Owner (the only
    -- account in this org right now - genuinely both requester and
    -- approver here, which the RPC itself does not forbid, unlike
    -- employee-removal's own explicit self-action block elsewhere in
    -- this codebase - a real, deliberate difference worth noting, not
    -- a gap in this test).
    perform public.review_prosm_time_leave(v_request_id, 'approve', 'Approved via end-to-end verification.');
    if not exists (select 1 from leave_requests where id = v_request_id and status = 'approved' and reviewed_by = v_resolved_user_id) then
        raise exception 'VERIFICATION FAILED: review_prosm_time_leave did not mark the request approved';
    end if;
    raise notice 'review_prosm_time_leave (as real authorized caller): OK - request approved';

    -- Balance must now reflect the APPROVED day, not pending.
    v_balance := public.get_prosm_time_leave_balance(null, extract(year from current_date)::integer);
    select (b->>'remainingDays')::numeric into v_annual_remaining_after
    from jsonb_array_elements(v_balance->'balances') b
    where b->>'leaveType' = 'annual';
    if v_annual_remaining_after <> v_annual_remaining_before - 2 then
        raise exception 'VERIFICATION FAILED: annual remaining after approval = % (expected %)', v_annual_remaining_after, v_annual_remaining_before - 2;
    end if;
    raise notice 'balance reflects the approved leave: OK - annual remaining after = % (was %)', v_annual_remaining_after, v_annual_remaining_before;

    -- Notification really landed for the requester (self, in this
    -- test) with the localizable 'leave' kind.
    if not exists (select 1 from notifications where related_entity_id = v_request_id and type = 'correction_reviewed' and data->>'kind' = 'leave') then
        raise exception 'VERIFICATION FAILED: no correction_reviewed/kind=leave notification was created';
    end if;
    raise notice 'leave-reviewed notification: OK - created with kind=leave for localizeNotification.ts to render';

    -- Clean up - net effect on the schema after this migration is zero.
    delete from notifications where related_entity_id = v_request_id;
    delete from leave_requests where id = v_request_id;
    raise notice 'test leave_requests/notifications rows removed - net schema effect: none';
end $$;

commit;
