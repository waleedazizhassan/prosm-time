-- PROSM Connect: who was invited to a meeting is kept with the meeting (the invitation itself leaves the switchboard
-- once it is received, as every request does - so joining could no longer find it). Deleted with the meeting (a day
-- after it ends). Joining and reading a meeting check this list.
-- Rollback: drop table connect_meeting_invitees; re-run prosm_time_connect_start_meeting, prosm_time_connect_join_meeting
-- and get_prosm_time_connect_meeting from 20261114120000 / 20261114140000.

begin;

create table public.connect_meeting_invitees (
    meeting_id uuid not null references public.connect_meetings(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    primary key (meeting_id, user_id)
);
alter table public.connect_meeting_invitees enable row level security;
revoke all on public.connect_meeting_invitees from public, anon, authenticated;

do $$
declare
    v_def text;
begin
    -- starting: the invitees are kept
    v_def := pg_get_functiondef('public.prosm_time_connect_start_meeting(text, uuid[], text)'::regprocedure);
    if position('    insert into connect_meeting_peers (meeting_id, user_id) values (v_meeting, v_me);' in v_def) = 0 then raise exception 'start: anchor'; end if;
    execute replace(v_def, '    insert into connect_meeting_peers (meeting_id, user_id) values (v_meeting, v_me);',
        '    insert into connect_meeting_peers (meeting_id, user_id) values (v_meeting, v_me);
    insert into connect_meeting_invitees (meeting_id, user_id) select distinct v_meeting, i from unnest(p_invitees) i where i <> v_me on conflict do nothing;');

    -- joining: invited (or the host, or already in it)
    v_def := pg_get_functiondef('public.prosm_time_connect_join_meeting(uuid)'::regprocedure);
    if position('and not exists (select 1 from connect_meeting_peers where meeting_id = p_meeting_id and user_id = v_me)' in v_def) = 0 then raise exception 'join: anchor'; end if;
    execute replace(v_def, 'and not exists (select 1 from connect_meeting_peers where meeting_id = p_meeting_id and user_id = v_me)',
        'and not exists (select 1 from connect_meeting_peers where meeting_id = p_meeting_id and user_id = v_me)
       and not exists (select 1 from connect_meeting_invitees where meeting_id = p_meeting_id and user_id = v_me)');

    -- reading: the same people
    v_def := pg_get_functiondef('public.get_prosm_time_connect_meeting(uuid)'::regprocedure);
    if position('or exists (select 1 from connect_meeting_peers p where p.meeting_id = m.id and p.user_id = public.current_prosm_time_user_id())' in v_def) = 0 then raise exception 'get: anchor'; end if;
    execute replace(v_def, 'or exists (select 1 from connect_meeting_peers p where p.meeting_id = m.id and p.user_id = public.current_prosm_time_user_id())',
        'or exists (select 1 from connect_meeting_peers p where p.meeting_id = m.id and p.user_id = public.current_prosm_time_user_id())
           or exists (select 1 from connect_meeting_invitees i where i.meeting_id = m.id and i.user_id = public.current_prosm_time_user_id())');
end $$;

commit;
