-- 2026-11-09 integration hardening and retention (spec acceptance: webhooks SSRF / Key ID; no data
-- kept without a stated retention).
--   * A webhook address must be public HTTPS on port 443 - no internal host names, no private or
--     loopback address literals (the dispatcher also checks every DNS answer before each delivery).
--   * Each delivery says which signing secret signed it (kid = the secret's public prefix).
--   * Retention, run daily and stated in the API contract and help:
--       API request log            90 days
--       delivered/failed webhooks  30 days
--       reviewed imported attendance 180 days (the attendance records it created stay)

begin;

-- the address rule in the database too
create or replace function public.prosm_time_webhook_url_ok(p_url text)
returns boolean
language sql
immutable
set search_path = public
as $$
    select p_url ~ '^https://[A-Za-z0-9.-]+(:443)?(/[^\s]*)?$'
       and length(p_url) <= 500
       and lower(substring(p_url from '^https://([^/:]+)')) !~ '(^localhost$|\.localhost$|\.local$|\.internal$|\.intranet$|\.lan$|\.home$|\.corp$)'
       and substring(p_url from '^https://([^/:]+)') like '%.%'
       and substring(p_url from '^https://([^/:]+)') !~ '^(0|10|127|169\.254|172\.(1[6-9]|2[0-9]|3[01])|192\.168|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.';
$$;
revoke all on function public.prosm_time_webhook_url_ok(text) from public, anon;

do $$
declare
    v_def text := pg_get_functiondef('public.create_prosm_time_webhook(text, text[], text, text)'::regprocedure);
    v_old text := '    if p_url is null or p_url !~ ''^https://[^\s/$.?#].[^\s]*$'' or length(p_url) > 500 then raise exception ''THE ADDRESS MUST START WITH https://''; end if;';
begin
    if position(v_old in v_def) = 0 then raise exception 'webhook create: anchor not found'; end if;
    execute replace(v_def, v_old,
        '    if p_url is null or p_url !~ ''^https://'' then raise exception ''THE ADDRESS MUST START WITH https://''; end if;
    if not public.prosm_time_webhook_url_ok(p_url) then raise exception ''THE ADDRESS MUST BE A PUBLIC HTTPS ADDRESS ON PORT 443''; end if;');
end $$;

-- the key id travels with each claimed delivery
do $$
declare
    v_def text := pg_get_functiondef('public.prosm_time_webhook_claim(integer)'::regprocedure);
    v_old text := '''url'', e.url, ''secret'', e.secret,';
begin
    if position(v_old in v_def) = 0 then raise exception 'webhook claim: anchor not found'; end if;
    execute replace(v_def, v_old, '''url'', e.url, ''secret'', e.secret, ''keyId'', e.secret_prefix,');
end $$;

-- retention
create or replace function public.prosm_time_integration_retention()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_log integer;
    v_outbox integer;
    v_imports integer;
begin
    delete from api_request_log where created_at < now() - interval '90 days';
    get diagnostics v_log = row_count;
    delete from webhook_outbox o where o.created_at < now() - interval '30 days'
      and not exists (select 1 from webhook_deliveries d where d.outbox_id = o.id and d.status in ('pending', 'sending'));
    get diagnostics v_outbox = row_count;
    delete from api_attendance_imports where status in ('applied', 'rejected') and coalesce(reviewed_at, created_at) < now() - interval '180 days';
    get diagnostics v_imports = row_count;
    return jsonb_build_object('requestLog', v_log, 'webhookEvents', v_outbox, 'imports', v_imports);
end;
$$;
revoke all on function public.prosm_time_integration_retention() from public, anon, authenticated;
grant execute on function public.prosm_time_integration_retention() to service_role;

do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'prosm-time-integration-retention';
exception
    when undefined_table then null;
end $$;
select cron.schedule('prosm-time-integration-retention', '20 3 * * *', $cron$select public.prosm_time_integration_retention();$cron$);

commit;
