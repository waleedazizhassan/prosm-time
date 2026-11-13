-- PROSM Connect: a meeting invitation without a title lost its kind (NULL || text is NULL in SQL), so a video
-- meeting was announced as a voice one. The invitation now always carries "<title>|<video or audio>".
-- Rollback: re-run prosm_time_connect_start_meeting from 20261114120000.

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_connect_start_meeting(text, uuid[], text)'::regprocedure);
    v_old text := 'left(nullif(trim(coalesce(p_title, '''')), ''''), 120) || ''|'' || p_media';
begin
    if position(v_old in v_def) = 0 then raise exception 'start meeting: anchor not found'; end if;
    execute replace(v_def, v_old, 'coalesce(left(nullif(trim(coalesce(p_title, '''')), ''''), 120), '''') || ''|'' || p_media');
end $$;

commit;
