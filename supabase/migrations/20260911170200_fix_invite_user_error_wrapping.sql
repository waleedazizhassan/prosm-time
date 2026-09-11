-- Redeploys create_invited_prosm_time_user with the exception-wrapping fix (the original 20260911170000 migration already applied with the bug present).
-- § real bug, user-reported - two real employees ended up with the
-- exact same display name (different emails), and it genuinely
-- confused the user testing the app (traced a real clock-in report to
-- session/local-state confusion between the two identically-named
-- accounts). The real, fast-feedback check lives in invite-user/
-- index.ts (before the Auth account is even created, so a rejected
-- duplicate never orphans one) - this is defense-in-depth for any
-- other real or future caller of this RPC directly.
create or replace function public.create_invited_prosm_time_user(
    p_organization_id uuid,
    p_auth_user_id uuid,
    p_actor_user_id uuid,
    p_role_key text,
    p_email text,
    p_full_name text,
    p_verification_code text,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_role_id uuid;
    v_user_id uuid;
begin
    if p_role_key not in ('manager', 'supervisor', 'employee', 'read_only') then
        raise exception 'INVALID ROLE FOR AN INVITED USER';
    end if;

    select id into v_role_id from roles where role_key = p_role_key;
    if v_role_id is null then
        raise exception 'ROLE NOT FOUND';
    end if;

    if exists (select 1 from users where organization_id = p_organization_id and email = lower(trim(p_email))) then
        raise exception 'A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION';
    end if;

    if exists (select 1 from users where organization_id = p_organization_id and lower(trim(full_name)) = lower(trim(p_full_name))) then
        raise exception 'A USER WITH THIS NAME ALREADY EXISTS IN THIS ORGANIZATION';
    end if;

    insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner)
    values (p_auth_user_id, p_organization_id, v_role_id, lower(trim(p_email)), p_full_name, 'invited', false)
    returning id into v_user_id;

    insert into user_invitations (user_id, verification_code, status, expires_at)
    values (v_user_id, p_verification_code, 'PENDING', p_expires_at);

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        p_organization_id, p_actor_user_id, v_user_id, 'USER_INVITED', 'users', v_user_id,
        'Invited ' || p_email || ' as ' || p_role_key || '.', jsonb_build_object('roleKey', p_role_key)
    );

    return jsonb_build_object('success', true, 'userId', v_user_id);
exception
    when unique_violation then
        raise exception 'A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION';
    when others then
        -- § real bug found while adding the name-uniqueness check above:
        -- this catch-all used to re-wrap EVERY exception (including the
        -- deliberate, clean validation messages raised above) into
        -- "CREATE INVITED PROSM TIME USER FAILED: <original message>" -
        -- which never matches humanizeBackendError.ts's exact-string
        -- lookup table, so the caller always saw the generic fallback
        -- instead of the specific, already-translated message. Bare
        -- `raise;` re-raises the original exception completely
        -- unchanged; only a genuinely unexpected error still gets
        -- wrapped for the generic fallback path to catch.
        if sqlerrm in (
            'INVALID ROLE FOR AN INVITED USER',
            'ROLE NOT FOUND',
            'A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION',
            'A USER WITH THIS NAME ALREADY EXISTS IN THIS ORGANIZATION'
        ) then
            raise;
        end if;
        raise exception 'CREATE INVITED PROSM TIME USER FAILED: %', sqlerrm;
end;
$function$;
