-- Owner 2026-11-17: "delete every Ratomag employee whose name starts with qa" - the QA test accounts made during the
-- release checks, with every record that points at them (records that block a deletion are removed first).
begin;
do $$
declare
    v_ids uuid[];
    v_auth uuid[];
    v_fk record;
    v_round integer := 0;
    v_left integer;
begin
    select array_agg(id), array_agg(auth_user_id) into v_ids, v_auth
    from public.users where organization_id = '40de8634-a058-4d71-8dee-193fb94d12a3' and (email ilike '%+qa-%' or full_name ilike 'QA %');
    if v_ids is null then return; end if;
    -- the rows that would block the deletion (foreign keys without cascade / set null), table by table
    for v_fk in
        select c.conrelid::regclass as tbl, a.attname as col
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'public.users'::regclass and c.confdeltype in ('a', 'r') and array_length(c.conkey, 1) = 1
    loop
        execute format('delete from %s where %I = any($1)', v_fk.tbl, v_fk.col) using v_ids;
    end loop;
    delete from public.users where id = any(v_ids);
    delete from auth.users where id = any(v_auth);
    raise notice 'removed % QA accounts', array_length(v_ids, 1);
end $$;
commit;
