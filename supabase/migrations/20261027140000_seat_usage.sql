-- v2.3.55 (owner 2026-10-27: "the company card should show how many users
-- the licence allows and how many there actually are"): the number of the
-- organisation's active people (the Owner included), whoever reads it - a
-- manager sees only their own sites' people, so counting on their side
-- would come up short.

begin;

create or replace function public.get_prosm_time_seat_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    return jsonb_build_object(
        'activeUsers', (select count(*) from users where organization_id = v_org and is_active),
        'maxUsers', (select max_users from license_activation_state where organization_id = v_org)
    );
end;
$function$;

revoke all on function public.get_prosm_time_seat_usage() from public, anon;
grant execute on function public.get_prosm_time_seat_usage() to authenticated;

commit;
