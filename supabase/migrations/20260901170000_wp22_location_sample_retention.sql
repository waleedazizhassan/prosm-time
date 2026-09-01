-- PROSM Time Implementation Master File V3.0, WP-22 (Security
-- Hardening | §24: "Configurable retention/deletion for location and
-- camera evidence"). Camera evidence got a real retention foundation
-- in WP-08 (retention_expires_at + list/delete RPCs + a purge Edge
-- Function, no automatic schedule wired up - explicitly deferred, not
-- silently built halfway); location_samples never got the equivalent.
-- Same shape, replicated here: location data is more sensitive/
-- higher-volume than evidence photos and deserves a shorter default
-- window (30 days vs. camera evidence's 90) - a real, documented
-- default (§24 does not specify an exact number), not a guess dressed
-- up as policy.
--
-- Unlike camera evidence, there is no external storage object to
-- coordinate with, so this is a single bulk-delete RPC rather than
-- WP-08's list-then-delete-per-row shape.

begin;

alter table public.location_samples
    add column retention_expires_at timestamptz not null default (now() + interval '30 days');

create index location_samples_retention_expires_at_idx on public.location_samples(retention_expires_at);

create or replace function public.purge_prosm_time_expired_location_samples()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_deleted_count integer;
begin
    delete from location_samples where retention_expires_at <= now();
    get diagnostics v_deleted_count = row_count;
    return jsonb_build_object('success', true, 'deletedCount', v_deleted_count);
exception
    when others then
        raise exception 'PURGE PROSM TIME EXPIRED LOCATION SAMPLES FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.purge_prosm_time_expired_location_samples() from public, anon, authenticated;
grant execute on function public.purge_prosm_time_expired_location_samples() to service_role;

commit;
