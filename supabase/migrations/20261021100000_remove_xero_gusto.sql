-- Owner 2026-10-21 (the review's "things we don't need", item 1 approved):
-- the Xero and Gusto payroll links are American/New Zealand products nobody
-- uses here, and they have been hidden since 2026-09-13. Removed the same way
-- as QuickBooks (20260915210000): their functions, tables and columns. The
-- edge functions are deleted from the project with this release.

begin;

do $$
declare
    v_fn record;
begin
    for v_fn in
        select p.oid::regprocedure as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like '%xero%' or p.proname like '%gusto%')
    loop
        execute format('drop function if exists %s', v_fn.signature);
    end loop;
end;
$$;

drop index if exists public.attendance_sessions_xero_unsynced_idx;
drop index if exists public.attendance_sessions_gusto_unsynced_idx;

alter table public.attendance_sessions drop column if exists xero_synced_at;
alter table public.attendance_sessions drop column if exists xero_external_id;
alter table public.attendance_sessions drop column if exists gusto_synced_at;
alter table public.attendance_sessions drop column if exists gusto_external_id;

drop table if exists public.xero_oauth_states;
drop table if exists public.xero_connections;
drop table if exists public.gusto_oauth_states;
drop table if exists public.gusto_connections;

commit;
