-- 2026-11-10 (owner): a "Buzz" - the owner, a manager or a supervisor taps Buzz on a person (to tell
-- them "clock in", "clock out", "call me", or anything else) and that person's phone vibrates and
-- sounds. Only someone with authority over the person (the same rule as every other decision about
-- them: the owner, or a manager/supervisor of a site the person works at) can buzz them; one buzz per
-- sender and person every 30 seconds. It is a notification of type 'buzz' - the phone gets it as a
-- push like any other.
-- Rollback: drop function send_prosm_time_buzz(uuid, text, text); remove 'buzz' from
-- notifications_type_check; alter publication supabase_realtime drop table public.notifications.

begin;

do $types$
declare
    v_def text;
begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_check';
    if v_def is not null and position('''buzz''' in v_def) = 0 then
        v_def := replace(v_def, '''license_changed''::text', '''license_changed''::text, ''buzz''::text');
        if position('''buzz''' in v_def) = 0 then raise exception 'notification type anchor not found'; end if;
        alter table public.notifications drop constraint notifications_type_check;
        execute 'alter table public.notifications add constraint notifications_type_check ' || v_def;
    end if;
end;
$types$;

create or replace function public.send_prosm_time_buzz(p_user_id uuid, p_reason text default 'attention', p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_role text;
    v_reason text := coalesce(nullif(trim(p_reason), ''), 'attention');
    v_message text := nullif(trim(coalesce(p_message, '')), '');
    v_from text;
    v_id uuid;
begin
    if v_me is null or v_org is null then raise exception 'NOT AUTHENTICATED'; end if;
    if p_user_id = v_me then raise exception 'YOU CANNOT BUZZ YOURSELF'; end if;
    if v_reason not in ('clock_in', 'clock_out', 'call_me', 'attention') then raise exception 'INVALID BUZZ REASON'; end if;
    if v_message is not null and char_length(v_message) > 140 then raise exception 'BUZZ MESSAGE TOO LONG'; end if;
    -- the owner, a manager or a supervisor - with authority over this person
    select r.role_key into v_role from users u join roles r on r.id = u.role_id where u.id = v_me;
    if not (public.current_prosm_time_user_is_owner() or coalesce(v_role, '') in ('manager', 'supervisor')) then
        raise exception 'PERMISSION DENIED';
    end if;
    if not public.prosm_time_caller_has_authority_over(p_user_id) then raise exception 'PERMISSION DENIED'; end if;
    if not exists (select 1 from users where id = p_user_id and organization_id = v_org and is_active) then raise exception 'PERSON NOT FOUND'; end if;
    if exists (
        select 1 from notifications
        where user_id = p_user_id and type = 'buzz' and data ->> 'fromUserId' = v_me::text and created_at > now() - interval '30 seconds'
    ) then
        raise exception 'BUZZ TOO SOON';
    end if;

    select full_name into v_from from users where id = v_me;
    insert into notifications (organization_id, user_id, type, priority, title, body, data)
    values (v_org, p_user_id, 'buzz', 'normal', 'Buzz from ' || coalesce(v_from, ''),
            coalesce(v_message, case v_reason when 'clock_in' then 'Please clock in.' when 'clock_out' then 'Please clock out.' when 'call_me' then 'Please call me.' else 'Please check the app.' end),
            jsonb_build_object('fromUserId', v_me, 'fromName', coalesce(v_from, ''), 'reason', v_reason, 'message', v_message))
    returning id into v_id;
    return jsonb_build_object('success', true, 'notificationId', v_id);
end;
$$;
-- a new notification reaches the open app at once (the live feed; row security still applies)
do $rt$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
        alter publication supabase_realtime add table public.notifications;
    end if;
end;
$rt$;

revoke all on function public.send_prosm_time_buzz(uuid, text, text) from public, anon;
grant execute on function public.send_prosm_time_buzz(uuid, text, text) to authenticated;

commit;
