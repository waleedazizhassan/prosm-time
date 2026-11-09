-- 2026-11-09 (owner: the customer's logo on every report): the external labour pay run carries the
-- organisation's name and logo, so its PDF and Excel lead with them.

begin;

do $$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_external_run(uuid)'::regprocedure);
    v_old text := '        ''rules'', v_data -> ''rules'',';
begin
    if position(v_old in v_def) = 0 then raise exception 'external run: anchor not found'; end if;
    execute replace(v_def, v_old, '        ''organization'', (select jsonb_build_object(''name'', name, ''logoUrl'', logo_url) from organizations where id = v_run.organization_id),
        ''rules'', v_data -> ''rules'',');
end $$;

commit;
