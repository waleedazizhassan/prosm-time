-- PROSM Time - user-directed removal (2026-09-15): "حتى في بروسم تايم
-- عايز الغي العلاقة بكويك بوكس" - PROSM Finance now computes payroll
-- natively (pulling hours/rate/allowances/leave straight from PROSM
-- Time's own attendance:read/payroll:read API-key bridge, see
-- prosm-finance's own Phase 6/7), so the whole point of this
-- integration (getting hours into a payroll system) no longer needs an
-- external product at all. Mirrors the exact same clean-removal shape
-- already applied to PROSM Finance's own (never-really-used) QuickBooks
-- GL sync (that repo's commit b8904d7): drop the tables/RPCs/columns,
-- delete the 3 deployed Edge Functions, strip the frontend provider
-- entry. Xero/Gusto are untouched - they were never the subject of
-- this instruction, and stay exactly as dormant/hidden as before
-- (§ user-directed 2026-09-09/2026-09-13, PayrollIntegrationCard.tsx's
-- own header comment).
--
-- Local commit only, per the standing hold on this repo's remote -
-- batched with the other pending local-only changes (the Integrations
-- nav re-show, f488ae4) for one future release, not pushed now.

begin;

drop function if exists public.record_prosm_time_quickbooks_sync_result(uuid, jsonb);
drop function if exists public.record_prosm_time_quickbooks_session_synced(uuid, text);
drop function if exists public.list_prosm_time_unsynced_sessions_for_quickbooks(uuid, int);
drop function if exists public.record_prosm_time_quickbooks_token_refresh(uuid, text, text, timestamptz, timestamptz);
drop function if exists public.get_prosm_time_quickbooks_connection_for_sync(uuid);
drop function if exists public.upsert_prosm_time_quickbooks_connection(uuid, text, text, text, text, timestamptz, timestamptz, uuid);
drop function if exists public.consume_prosm_time_quickbooks_oauth_state(text);
drop function if exists public.get_prosm_time_quickbooks_status();
drop function if exists public.disconnect_prosm_time_quickbooks();
drop function if exists public.start_prosm_time_quickbooks_connection();

drop index if exists public.attendance_sessions_quickbooks_unsynced_idx;

alter table public.attendance_sessions drop column if exists quickbooks_synced_at;
alter table public.attendance_sessions drop column if exists quickbooks_time_activity_id;

drop table if exists public.quickbooks_oauth_states;
drop table if exists public.quickbooks_connections;

commit;
