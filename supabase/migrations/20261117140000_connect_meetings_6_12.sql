-- Owner 2026-11-16 ("we agreed: video up to 6, voice up to 12"): a meeting holds 6 with video and 12 with voice only
-- (it was 4 / 8). Meetings already running keep the size they were started with.
-- Rollback: restore the checks (2..8; video <= 4, audio <= 8) and re-run prosm_time_connect_start_meeting from 20261114120000 (4 / 8).
begin;
-- the table's own limits follow (they were 2..8, video <= 4)
do $$
declare c record;
begin
    for c in select conname from pg_constraint where conrelid = 'public.connect_meetings'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%max_peers%' loop
        execute format('alter table public.connect_meetings drop constraint %I', c.conname);
    end loop;
end $$;
alter table public.connect_meetings add constraint connect_meetings_max_peers_range check (max_peers between 2 and 12);
alter table public.connect_meetings add constraint connect_meetings_max_peers_media
    check ((media = 'video' and max_peers <= 6) or (media = 'audio' and max_peers <= 12));
do $$
declare
    v_def text;
    v_old text := $q$v_max integer := case p_media when 'video' then 4 else 8 end;$q$;
    v_new text := $q$v_max integer := case p_media when 'video' then 6 else 12 end;$q$;
    v_sig regprocedure := (select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'prosm_time_connect_start_meeting' order by p.oid desc limit 1);
begin
    v_def := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
    if position(v_new in v_def) > 0 then return; end if;
    if position(v_old in v_def) = 0 then raise exception 'start meeting: limit anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $$;
commit;
