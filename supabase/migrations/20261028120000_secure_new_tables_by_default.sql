-- v2.3.57 (owner 2026-10-28, after the security review: "RLS is a living
-- system - make forgetting safe"): a table created in the public schema has
-- row level security switched on the moment it is created - so with no
-- policy written yet, nobody reads or writes it (deny all) - and the public
-- (anon) key gets no rights on it at all. A table becomes reachable only
-- through the policies and grants its own migration writes on purpose.
-- (The test suite also fails if any table lacks RLS or a bucket turns
-- public unexpectedly: supabase/tests/secureByDefault.test.ts.)

begin;

create or replace function public.prosm_time_secure_new_tables()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_command record;
begin
    for v_command in
        select object_identity from pg_event_trigger_ddl_commands()
        where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
          and object_type = 'table'
          and schema_name = 'public'
    loop
        execute format('alter table %s enable row level security', v_command.object_identity);
        execute format('revoke all on %s from anon', v_command.object_identity);
    end loop;
end;
$function$;

revoke all on function public.prosm_time_secure_new_tables() from public, anon, authenticated;

drop event trigger if exists prosm_time_secure_new_tables;
create event trigger prosm_time_secure_new_tables
    on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    execute function public.prosm_time_secure_new_tables();

-- The audit log's "is this an email delivery row" helper (20261028100000) kept
-- the default execute grant; it is only called inside the definer functions
-- of the log and the dashboard, so nobody needs to call it directly.
revoke all on function public.prosm_time_audit_is_delivery(text) from public, anon, authenticated;

commit;
