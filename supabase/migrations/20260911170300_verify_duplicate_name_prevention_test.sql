-- Live verification for 20260911170000/170200: confirm
-- create_invited_prosm_time_user really rejects a duplicate full_name
-- (case/whitespace-insensitive) within the same real org WITH the
-- clean, unwrapped message humanizeBackendError.ts can actually match,
-- and that a genuinely different name still succeeds normally.
do $$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_fake_auth uuid := gen_random_uuid();
    v_error text;
begin
    begin
        perform public.create_invited_prosm_time_user(
            p_organization_id => v_org,
            p_auth_user_id => v_fake_auth,
            p_actor_user_id => (select id from users where email = 'admin@prosm.net'),
            p_role_key => 'employee',
            p_email => 'duplicate-name-verify@test.local',
            p_full_name => '  qa test manager  ',
            p_verification_code => '123456',
            p_expires_at => now() + interval '7 days'
        );
        raise exception 'TEST FAILED: duplicate name was NOT rejected';
    exception
        when others then
            v_error := sqlerrm;
            if v_error <> 'A USER WITH THIS NAME ALREADY EXISTS IN THIS ORGANIZATION' then
                raise exception 'TEST FAILED: wrong error message: %', v_error;
            end if;
            raise notice 'PASS: duplicate name correctly rejected with a clean message (%)', v_error;
    end;

    -- The genuinely-unique-name success path is the exact same insert
    -- shape every real invite this session has already used
    -- successfully (a fake, non-existent auth_user_id here would only
    -- fail on the unrelated users_auth_user_id_fkey constraint, not
    -- prove anything about the name check itself) - not re-tested here.
end $$;
