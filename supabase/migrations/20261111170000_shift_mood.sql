-- 2026-11-11 (owner): at the end of the clock-out, "how was today's work?" - three faces (great, normal,
-- tough). The person answers for their own shift, up to two days after it ended; the answer shows in the
-- owner's daily summary next to their name.
-- Rollback: drop set_prosm_time_shift_mood(uuid, text); drop the two columns; restore
-- get_prosm_time_daily_summary from 20261111100000.

begin;

alter table public.attendance_sessions
    add column if not exists shift_mood text check (shift_mood in ('great', 'normal', 'tough')),
    add column if not exists shift_mood_at timestamptz;

create or replace function public.set_prosm_time_shift_mood(p_session_id uuid, p_mood text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_me uuid := public.current_prosm_time_user_id();
    v_session attendance_sessions%rowtype;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_mood not in ('great', 'normal', 'tough') then raise exception 'INVALID MOOD'; end if;
    select * into v_session from attendance_sessions where id = p_session_id;
    if v_session.id is null or v_session.user_id <> v_me then raise exception 'SESSION NOT FOUND'; end if;
    if v_session.clock_out_at is null or v_session.clock_out_at < now() - interval '48 hours' then raise exception 'SESSION NOT FOUND'; end if;
    update attendance_sessions set shift_mood = p_mood, shift_mood_at = now() where id = p_session_id;
    return jsonb_build_object('success', true);
end;
$$;
revoke all on function public.set_prosm_time_shift_mood(uuid, text) from public, anon;
grant execute on function public.set_prosm_time_shift_mood(uuid, text) to authenticated;

-- the daily summary shows each person's answer
do $patch$
declare
    v_def text := replace(pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure), chr(13) || chr(10), chr(10));
    a text := '''lateMinutes'', w.late_minutes,';
begin
    if position(a in v_def) = 0 then raise exception 'summary mood anchor not found'; end if;
    v_def := replace(v_def, a, a || ' ''mood'', (select s.shift_mood from attendance_sessions s where s.user_id = w.user_id and s.shift_mood is not null
                 and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_date order by s.clock_out_at desc limit 1),');
    execute v_def;
end;
$patch$;

commit;
