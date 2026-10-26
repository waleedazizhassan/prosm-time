-- v2.3.43 step 21 (audit, owner request: "the trial must not be tampered
-- with"): when a 30-day trial ends, the organisation is locked - its members
-- are no longer recognised (current_prosm_time_user_id /
-- current_prosm_time_organization_id). The external export API
-- authenticates with an API key under the service role instead, which
-- skipped that lock: a locked trial organisation could keep pulling its
-- attendance, allowances, leave and payroll exports. The key now answers
-- nothing while the organisation is locked (the data is kept, as before,
-- and the key works again once the license is renewed).

begin;

create or replace function public.authenticate_prosm_time_api_key(p_raw_key text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_hash text;
    v_key_id uuid;
    v_org uuid;
begin
    if p_raw_key is null or length(p_raw_key) = 0 then
        return null;
    end if;

    v_hash := encode(sha256(convert_to(p_raw_key, 'utf8')), 'hex');

    select id, organization_id into v_key_id, v_org
    from api_keys
    where key_hash = v_hash and revoked_at is null;

    if v_key_id is null then
        return null;
    end if;

    -- step 21: a locked (ended) trial organisation is not served
    if public.prosm_time_org_locked(v_org) then
        return null;
    end if;

    update api_keys set last_used_at = now() where id = v_key_id;

    return v_org;
end;
$function$;

revoke all on function public.authenticate_prosm_time_api_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_prosm_time_api_key(text) to service_role;

commit;
