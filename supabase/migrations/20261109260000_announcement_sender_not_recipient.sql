-- 2026-11-09 (owner): "when I send to the whole organisation it reaches me too - the sender should not
-- receive it." The publisher is no longer a recipient of their own announcement (they see it in
-- their Publish list, with who read it). A scheduled one leaves out whoever wrote it.
-- Rollback: restore prosm_time_publish_announcement_now from 20261109230000.

begin;

do $patch$
declare
    v_def text := pg_get_functiondef('public.prosm_time_publish_announcement_now(uuid,uuid)'::regprocedure);
    v_anchor text := '    from public.prosm_time_announcement_audience(p_announcement_id) r(id)
    join users u on u.id = r.id
    on conflict do nothing;';
begin
    if position(v_anchor in v_def) = 0 then raise exception 'publish anchor not found'; end if;
    v_def := replace(v_def, v_anchor, '    from public.prosm_time_announcement_audience(p_announcement_id) r(id)
    join users u on u.id = r.id
    where r.id is distinct from p_actor and r.id is distinct from v_a.created_by
    on conflict do nothing;');
    execute v_def;
end;
$patch$;

commit;
