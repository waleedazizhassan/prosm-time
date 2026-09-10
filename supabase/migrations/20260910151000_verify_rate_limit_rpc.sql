-- Self-cleaning live verification for 20260910150000's real rate
-- limiter: consumes a scope/identifier pair past its limit and
-- confirms it actually blocks, then confirms a DIFFERENT identifier in
-- the same scope is unaffected (proves the limiter is keyed correctly,
-- not globally blocking). Uses a throwaway scope/identifier that could
-- never collide with a real caller.
do $$
declare
    v_result jsonb;
    v_allowed_count integer := 0;
    i integer;
begin
    delete from security_rate_limits where scope = 'verify_rate_limit_scope';

    for i in 1..3 loop
        v_result := public.consume_prosm_time_rate_limit('verify_rate_limit_scope', 'verify-identifier-a', 3, 900, 900);
        if coalesce((v_result->>'allowed')::boolean, false) then
            v_allowed_count := v_allowed_count + 1;
        end if;
    end loop;
    if v_allowed_count <> 3 then
        raise exception 'VERIFICATION FAILED: expected all 3 of the first 3 attempts to be allowed, got % allowed.', v_allowed_count;
    end if;

    v_result := public.consume_prosm_time_rate_limit('verify_rate_limit_scope', 'verify-identifier-a', 3, 900, 900);
    if coalesce((v_result->>'allowed')::boolean, true) then
        raise exception 'VERIFICATION FAILED: the 4th attempt at the same identifier should have been blocked.';
    end if;
    if (v_result->>'retryAfterSeconds') is null then
        raise exception 'VERIFICATION FAILED: a blocked response must carry retryAfterSeconds.';
    end if;

    -- A different identifier in the SAME scope must be unaffected -
    -- proves the limiter keys on (scope, identifier), not scope alone.
    v_result := public.consume_prosm_time_rate_limit('verify_rate_limit_scope', 'verify-identifier-b', 3, 900, 900);
    if not coalesce((v_result->>'allowed')::boolean, false) then
        raise exception 'VERIFICATION FAILED: a different identifier in the same scope should not have been blocked.';
    end if;

    raise notice 'VERIFIED: consume_prosm_time_rate_limit allows up to the limit, blocks past it with a retry-after, and keys correctly per identifier.';

    delete from security_rate_limits where scope = 'verify_rate_limit_scope';
end $$;
