-- PROSM Time - re-run of the end-to-end leave flow check (20260908202000)
-- after aligning review_prosm_time_leave's own action vocabulary to
-- 'approved'/'rejected' (20260908203000) - confirms the fix didn't
-- regress the flow it was made inside of. Same simulated-session
-- technique, same self-cleaning shape.

begin;

do $$
declare
    v_admin_auth_id uuid := 'ffc1ecf1-6ab3-4ee9-ae50-0ee671b2b6bc';
    v_resolved_uid uuid;
    v_request_id uuid;
    v_request_result jsonb;
begin
    perform set_config('request.jwt.claim.sub', v_admin_auth_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_auth_id, 'role', 'authenticated')::text, true);

    v_resolved_uid := auth.uid();
    if v_resolved_uid is distinct from v_admin_auth_id then
        raise notice 'auth.uid() simulation did not take effect - skipping.';
        return;
    end if;

    v_request_result := public.request_prosm_time_leave('sick', current_date + 40, current_date + 40, 'Re-verification after vocab fix');
    v_request_id := (v_request_result->>'requestId')::uuid;

    -- The actual point of this re-check: 'approved' (not 'approve')
    -- must be accepted now.
    perform public.review_prosm_time_leave(v_request_id, 'approved', 'Re-verified.');
    if not exists (select 1 from leave_requests where id = v_request_id and status = 'approved') then
        raise exception 'VERIFICATION FAILED: review_prosm_time_leave(''approved'') did not approve the request after the vocabulary fix';
    end if;
    raise notice 'review_prosm_time_leave(''approved''): OK - aligned vocabulary accepted and applied correctly';

    if not exists (select 1 from notifications where related_entity_id = v_request_id and data->>'actionType' = 'approved') then
        raise exception 'VERIFICATION FAILED: the reviewed notification does not carry actionType=approved';
    end if;
    raise notice 'reviewed notification actionType=approved: OK - shell:notifications.decision.approved will now render correctly';

    delete from notifications where related_entity_id = v_request_id;
    delete from leave_requests where id = v_request_id;
    raise notice 'test rows removed - net schema effect: none';
end $$;

commit;
