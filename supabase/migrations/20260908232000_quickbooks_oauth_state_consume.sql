-- PROSM Time - service-role-only lookup for the QuickBooks OAuth
-- callback (added as its own migration rather than folded into
-- 20260908231000, which had already been pushed - never edit an
-- already-applied migration file). Single-use: looks up and
-- immediately deletes the state row, so a replayed callback (an
-- Intuit retry, or a curious user re-visiting the callback URL) can
-- never resolve an organization a second time.

begin;

create or replace function public.consume_prosm_time_quickbooks_oauth_state(p_state text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid;
begin
    delete from quickbooks_oauth_states
    where state = p_state and expires_at > now()
    returning organization_id into v_org;

    return v_org;
end;
$function$;

revoke execute on function public.consume_prosm_time_quickbooks_oauth_state(text) from public, anon, authenticated;

commit;
