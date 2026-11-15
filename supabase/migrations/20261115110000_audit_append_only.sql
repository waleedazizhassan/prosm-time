-- Governance phase A (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md section 14.1).
-- The audit trail is append-only, in two layers:
--   1. privileges: no update, delete or truncate for anon, authenticated or service_role;
--   2. a trigger that refuses every update, delete and truncate - for the table owner too.
-- No session setting opens it. The only changes allowed are the ones a foreign key makes once its parent row
-- is gone, which nobody reaches without deleting the parent itself:
--   * a delete cascaded from a deleted parent (the organisation's deletion removes its rows);
--   * an ON DELETE SET NULL link emptied after the referenced row is gone (a removed person), with every other
--     column unchanged.
-- Both are read from pg_constraint at run time, not from a hand-kept list.
-- Tables: audit_logs, sensitive_access_log, data_deletion_log, entitlement_events. api_request_log keeps its
-- 90-day retention job (20261109170000) and is not part of this.
-- Known limit (documented): the table owner can ALTER TABLE ... DISABLE TRIGGER; that is infrastructure
-- administration, not the application.
-- Rollback: drop the triggers *_append_only / *_no_truncate and function prosm_time_append_only_guard,
-- and grant back the revoked privileges.

begin;

create or replace function public.prosm_time_append_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_fk record;
    v_old jsonb;
    v_new jsonb;
    v_set_null text[] := array[]::text[];
    v_parent_gone boolean;
begin
    if tg_op = 'TRUNCATE' then
        raise exception 'THE AUDIT TRAIL IS APPEND-ONLY (%)', tg_table_name;
    end if;

    v_old := to_jsonb(old);

    if tg_op = 'DELETE' then
        -- allowed only as the cascade of a deleted parent row
        for v_fk in
            select c.confrelid::regclass as parent, pa.attname as parent_col, ca.attname as child_col
            from pg_constraint c
            join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
            join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
            where c.conrelid = tg_relid and c.contype = 'f' and c.confdeltype = 'c' and cardinality(c.conkey) = 1
        loop
            if v_old ->> v_fk.child_col is not null then
                execute format('select not exists (select 1 from %s where %I::text = $1)', v_fk.parent, v_fk.parent_col)
                    into v_parent_gone using v_old ->> v_fk.child_col;
                if v_parent_gone then return old; end if;
            end if;
        end loop;
        raise exception 'THE AUDIT TRAIL IS APPEND-ONLY (%)', tg_table_name;
    end if;

    -- UPDATE: only ON DELETE SET NULL links emptied after their parent is gone, nothing else
    v_new := to_jsonb(new);
    for v_fk in
        select c.confrelid::regclass as parent, pa.attname as parent_col, ca.attname as child_col
        from pg_constraint c
        join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
        join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
        where c.conrelid = tg_relid and c.contype = 'f' and c.confdeltype = 'n' and cardinality(c.conkey) = 1
    loop
        if (v_new -> v_fk.child_col) is distinct from (v_old -> v_fk.child_col) then
            if v_new ->> v_fk.child_col is not null then
                raise exception 'THE AUDIT TRAIL IS APPEND-ONLY (%)', tg_table_name;
            end if;
            execute format('select not exists (select 1 from %s where %I::text = $1)', v_fk.parent, v_fk.parent_col)
                into v_parent_gone using v_old ->> v_fk.child_col;
            if not v_parent_gone then
                raise exception 'THE AUDIT TRAIL IS APPEND-ONLY (%)', tg_table_name;
            end if;
            v_set_null := v_set_null || v_fk.child_col::text;
        end if;
    end loop;
    if cardinality(v_set_null) = 0 or (v_old - v_set_null) is distinct from (v_new - v_set_null) then
        raise exception 'THE AUDIT TRAIL IS APPEND-ONLY (%)', tg_table_name;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_append_only_guard() from public, anon, authenticated;

do $$
declare
    v_table text;
begin
    foreach v_table in array array['audit_logs', 'sensitive_access_log', 'data_deletion_log', 'entitlement_events'] loop
        execute format('revoke update, delete, truncate on public.%I from anon, authenticated, service_role', v_table);
        execute format('drop trigger if exists %I on public.%I', v_table || '_append_only', v_table);
        execute format('create trigger %I before update or delete on public.%I for each row execute function public.prosm_time_append_only_guard()',
                       v_table || '_append_only', v_table);
        execute format('drop trigger if exists %I on public.%I', v_table || '_no_truncate', v_table);
        execute format('create trigger %I before truncate on public.%I for each statement execute function public.prosm_time_append_only_guard()',
                       v_table || '_no_truncate', v_table);
    end loop;
end $$;

commit;
