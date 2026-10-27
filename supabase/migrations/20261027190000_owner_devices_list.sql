-- v2.3.55 (owner 2026-10-27, "yes" to: "the Owner sees the devices and can
-- remove any of them"): a device whose app was removed or whose data was
-- cleared keeps its place for 30 days; the Owner can free it at once.
-- Removing a device that is still in use frees its place only until the app
-- opens there again (it then registers again, if the licence has room).

begin;

create or replace function public.list_prosm_time_devices()
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
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN SEE THE LICENCE'; end if;
    return coalesce((
        select jsonb_agg(d order by d ->> 'lastSeenAt' desc)
        from (
            select jsonb_build_object(
                'deviceId', s.device_id,
                'platform', max(s.platform),
                'label', max(s.label),
                'people', jsonb_agg(distinct u.full_name),
                'firstSeenAt', min(s.first_seen_at),
                'lastSeenAt', max(s.last_seen_at),
                'counted', max(s.last_seen_at) > now() - interval '30 days'
            ) as d
            from signed_in_devices s join users u on u.id = s.user_id
            where s.organization_id = v_org
            group by s.device_id
        ) x
    ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_prosm_time_devices() from public, anon;
grant execute on function public.list_prosm_time_devices() to authenticated;

create or replace function public.remove_prosm_time_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_caller uuid := public.current_prosm_time_user_id();
    v_removed integer;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner() then raise exception 'ONLY THE OWNER CAN SEE THE LICENCE'; end if;
    delete from signed_in_devices where organization_id = v_org and device_id = p_device_id;
    get diagnostics v_removed = row_count;
    if v_removed > 0 then
        insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, new_state)
        values (v_org, v_caller, 'device.removed', 'signed_in_devices', 'A device was removed from the licence''s devices', jsonb_build_object('deviceId', p_device_id));
    end if;
    return jsonb_build_object('success', true, 'removed', v_removed);
end;
$function$;

revoke all on function public.remove_prosm_time_device(text) from public, anon;
grant execute on function public.remove_prosm_time_device(text) to authenticated;

commit;
