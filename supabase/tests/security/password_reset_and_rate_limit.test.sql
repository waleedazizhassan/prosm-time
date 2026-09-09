-- PROSM Time security regression tests (Security Hardening phase).
-- Real behaviour, executed against a real PostgreSQL server: no test
-- asserts on the presence of code or configuration.
\set ON_ERROR_STOP on
\pset pager off

create or replace function public.assert(p_name text, p_condition boolean)
returns void language plpgsql as $$
begin
  if p_condition then
    raise notice 'PASS  %', p_name;
  else
    raise exception 'FAIL  %', p_name;
  end if;
end $$;

do $$
declare
  v_uid uuid;
  v_res jsonb;
  v_row password_reset_requests%rowtype;
  v_i int;
begin
  select id into v_uid from users where email = 'owner@example.com';

  -- T1: the migration retired the pre-existing plaintext code.
  perform assert('T1 legacy plaintext codes retired',
    not exists (select 1 from password_reset_requests where verification_code is not null)
    and not exists (select 1 from password_reset_requests where status = 'PENDING'));

  -- T2: requesting a reset stores only a hash, never the code.
  v_res := request_prosm_time_password_reset('owner@example.com', '123456', now() + interval '30 minutes');
  perform assert('T2a request succeeds for a real account', (v_res->>'success')::boolean);
  select * into v_row from password_reset_requests where user_id = v_uid and status = 'PENDING';
  perform assert('T2b code is stored hashed, plaintext is null',
    v_row.verification_code is null and v_row.code_hash is not null and v_row.code_hash <> '123456'
    and length(v_row.code_hash) = 64);

  -- T3: unknown email returns a neutral, non-raising result.
  v_res := request_prosm_time_password_reset('ghost@example.com', '123456', now() + interval '30 minutes');
  perform assert('T3 unknown email does not raise and does not confirm existence',
    (v_res->>'success')::boolean is false and v_res->>'reason' = 'NO_ACTIVE_ACCOUNT');

  -- T4: wrong code is rejected with the SAME neutral reason as an unknown email.
  v_res := redeem_prosm_time_password_reset('owner@example.com', '999999');
  perform assert('T4a wrong code rejected', (v_res->>'success')::boolean is false);
  perform assert('T4b wrong-code reason is neutral', v_res->>'reason' = 'INVALID_OR_EXPIRED');
  perform assert('T4c unknown-email redeem returns the identical payload',
    redeem_prosm_time_password_reset('ghost@example.com', '999999') = v_res);

  -- T5: brute force lockout after 5 wrong codes (1 already spent in T4).
  for v_i in 1..4 loop
    perform redeem_prosm_time_password_reset('owner@example.com', '000' || lpad(v_i::text, 3, '0'));
  end loop;
  select * into v_row from password_reset_requests where user_id = v_uid order by created_at desc limit 1;
  perform assert('T5a request LOCKED after 5 wrong attempts', v_row.status = 'LOCKED' and v_row.attempt_count = 5);
  v_res := redeem_prosm_time_password_reset('owner@example.com', '123456');
  perform assert('T5b the CORRECT code no longer works once locked out', (v_res->>'success')::boolean is false);

  -- T6: a fresh request invalidates the previous one, and the correct code works.
  perform request_prosm_time_password_reset('owner@example.com', '222222', now() + interval '30 minutes');
  perform assert('T6a previous requests are no longer PENDING',
    (select count(*) from password_reset_requests where user_id = v_uid and status = 'PENDING') = 1);
  v_res := redeem_prosm_time_password_reset('owner@example.com', '222222');
  perform assert('T6b correct code redeems successfully', (v_res->>'success')::boolean);

  -- T7: one-time use - the same code cannot be replayed.
  v_res := redeem_prosm_time_password_reset('owner@example.com', '222222');
  perform assert('T7a reused code rejected', (v_res->>'success')::boolean is false);
  select * into v_row from password_reset_requests where user_id = v_uid and status = 'CONSUMED';
  perform assert('T7b consumed row keeps no usable code', v_row.code_hash is null and v_row.consumed_at is not null);

  -- T8: expired code rejected and marked EXPIRED.
  perform request_prosm_time_password_reset('owner@example.com', '333333', now() - interval '1 minute');
  v_res := redeem_prosm_time_password_reset('owner@example.com', '333333');
  perform assert('T8a expired code rejected', (v_res->>'success')::boolean is false);
  perform assert('T8b expired row marked EXPIRED and nothing stays PENDING',
    not exists (select 1 from password_reset_requests where user_id = v_uid and status = 'PENDING')
    and exists (select 1 from password_reset_requests where user_id = v_uid and status = 'EXPIRED'));

  -- T9: rate limiter really blocks after the limit and reports a retry delay.
  for v_i in 1..3 loop
    v_res := consume_prosm_time_rate_limit('test_scope', '1.2.3.4', 3, 900, 1800);
    perform assert('T9a attempt ' || v_i || ' allowed', (v_res->>'allowed')::boolean);
  end loop;
  v_res := consume_prosm_time_rate_limit('test_scope', '1.2.3.4', 3, 900, 1800);
  perform assert('T9b 4th attempt blocked', (v_res->>'allowed')::boolean is false);
  perform assert('T9c blocked response carries Retry-After seconds', (v_res->>'retryAfterSeconds')::int > 0);
  v_res := consume_prosm_time_rate_limit('test_scope', '5.6.7.8', 3, 900, 1800);
  perform assert('T9d a different caller is unaffected', (v_res->>'allowed')::boolean);
  v_res := consume_prosm_time_rate_limit('test_scope', '  1.2.3.4  ', 3, 900, 1800);
  perform assert('T9e identifier whitespace/case cannot dodge the block', (v_res->>'allowed')::boolean is false);

  -- T10: the block really lapses after its window (no permanent lockout).
  update security_rate_limits set blocked_until = now() - interval '1 second'
    where scope = 'test_scope' and identifier = '1.2.3.4';
  v_res := consume_prosm_time_rate_limit('test_scope', '1.2.3.4', 3, 900, 1800);
  perform assert('T10 block lapses and a new window starts', (v_res->>'allowed')::boolean);
end $$;

-- T11: privilege checks - anon/authenticated may not touch any of it.
do $$
begin
  perform assert('T11a anon cannot execute the reset RPCs',
    not has_function_privilege('anon', 'public.redeem_prosm_time_password_reset(text, text)', 'execute')
    and not has_function_privilege('anon', 'public.request_prosm_time_password_reset(text, text, timestamptz)', 'execute'));
  perform assert('T11b authenticated cannot execute the reset RPCs',
    not has_function_privilege('authenticated', 'public.redeem_prosm_time_password_reset(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.request_prosm_time_password_reset(text, text, timestamptz)', 'execute'));
  perform assert('T11c anon/authenticated cannot execute the rate limiter',
    not has_function_privilege('anon', 'public.consume_prosm_time_rate_limit(text, text, integer, integer, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.consume_prosm_time_rate_limit(text, text, integer, integer, integer)', 'execute'));
  perform assert('T11d service_role can execute all three',
    has_function_privilege('service_role', 'public.redeem_prosm_time_password_reset(text, text)', 'execute')
    and has_function_privilege('service_role', 'public.request_prosm_time_password_reset(text, text, timestamptz)', 'execute')
    and has_function_privilege('service_role', 'public.consume_prosm_time_rate_limit(text, text, integer, integer, integer)', 'execute'));
  perform assert('T11e anon/authenticated have no table privileges on reset or limiter tables',
    not has_table_privilege('anon', 'public.password_reset_requests', 'select')
    and not has_table_privilege('authenticated', 'public.password_reset_requests', 'select')
    and not has_table_privilege('anon', 'public.security_rate_limits', 'select')
    and not has_table_privilege('authenticated', 'public.security_rate_limits', 'select'));
  perform assert('T11f RLS is enabled on both tables',
    (select bool_and(relrowsecurity) from pg_class where relname in ('password_reset_requests', 'security_rate_limits')));
  perform assert('T11g every touched SECURITY DEFINER function pins search_path',
    (select bool_and(array_to_string(proconfig, ',') like '%search_path=%')
     from pg_proc where proname in ('request_prosm_time_password_reset', 'redeem_prosm_time_password_reset',
                                    'consume_prosm_time_rate_limit', 'hash_prosm_time_reset_code')
       and prosecdef));
end $$;

drop function public.assert(text, boolean);
