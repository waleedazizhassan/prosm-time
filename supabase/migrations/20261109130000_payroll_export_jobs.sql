-- 2026-11-09 spec 15.11: payslips exported in bulk as a background job.
--   * A job is started for a cycle (approved or locked): every payslip in the caller's scope gets
--     its own serial number (never reused) in payroll_exports, and the job keeps the list.
--   * The Edge Function payroll-export-job builds each payslip PDF on the server from the stored
--     snapshot (the same layout as the emailed one), keeps status and progress, packs one ZIP in a
--     PRIVATE storage bucket, and hands it out through a short-lived signed link - after checking
--     the reader's permission again on every download.
--   * The file is deleted after the organisation's retention (7 days by default); a failed job
--     leaves no partial file and says why. File names carry no personal data.
--   * Big organisations: the threshold (200 by default) is a payroll setting; the app sends bulk
--     payslips of approved/locked cycles here, and uses it for any cycle above the threshold.
-- Tables are RPC-only. The worker functions are for the service role only.

begin;

alter table public.payroll_settings add column if not exists async_export_threshold integer not null default 200 check (async_export_threshold between 10 and 100000);
alter table public.payroll_settings add column if not exists export_retention_days integer not null default 7 check (export_retention_days between 1 and 90);

create table if not exists public.payroll_export_jobs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    cycle_id uuid not null references public.payroll_cycles(id) on delete cascade,
    cycle_version integer not null,
    report_type text not null default 'payslip' check (report_type in ('payslip')),
    file_format text not null default 'zip' check (file_format in ('zip')),
    requested_by uuid references public.users(id) on delete set null,
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'expired')),
    total integer not null default 0,
    done integer not null default 0,
    documents jsonb not null default '[]'::jsonb,
    storage_path text,
    error text,
    created_at timestamptz not null default now(),
    heartbeat_at timestamptz,
    finished_at timestamptz,
    expires_at timestamptz
);
create index if not exists payroll_export_jobs_cycle_idx on public.payroll_export_jobs (cycle_id, created_at desc);
create index if not exists payroll_export_jobs_open_idx on public.payroll_export_jobs (status) where status in ('queued', 'running');
alter table public.payroll_export_jobs enable row level security;
revoke all on public.payroll_export_jobs from anon, authenticated;

-- the private bucket: no client policies at all - only the service role reads and writes it
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payroll-exports', 'payroll-exports', false, 524288000, array['application/zip', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Start: the caller's scope decides who is in; one serial per payslip.
create or replace function public.start_prosm_time_payroll_export_job(p_cycle_id uuid, p_user_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cycle payroll_cycles%rowtype;
    v_me uuid := public.current_prosm_time_user_id();
    v_emp jsonb;
    v_serial bigint;
    v_docs jsonb := '[]'::jsonb;
    v_job uuid;
begin
    select * into v_cycle from payroll_cycles where id = p_cycle_id and organization_id = public.current_prosm_time_organization_id();
    if v_cycle.id is null then raise exception 'PAYROLL CYCLE NOT FOUND'; end if;
    perform public.prosm_time_require_feature('payroll');
    if v_cycle.status not in ('approved', 'locked') then raise exception 'ONLY AN APPROVED OR LOCKED CYCLE IS EXPORTED IN BULK'; end if;
    if exists (select 1 from payroll_export_jobs where cycle_id = p_cycle_id and requested_by = v_me and status in ('queued', 'running')) then
        raise exception 'AN EXPORT OF THIS CYCLE IS ALREADY RUNNING';
    end if;
    perform 1 from payroll_settings where organization_id = v_cycle.organization_id for update;
    for v_emp in
        select e from payroll_cycle_snapshots s, jsonb_array_elements(s.data -> 'employees') e
        where s.cycle_id = v_cycle.id and s.cycle_version = v_cycle.cycle_version
          and (p_user_ids is null or (e ->> 'user_id')::uuid = any(p_user_ids))
          and public.prosm_time_payroll_allows('payroll.export_payslips', nullif(e ->> 'site_id', '')::uuid)
        order by e ->> 'full_name'
    loop
        update payroll_settings set last_export_serial = last_export_serial + 1 where organization_id = v_cycle.organization_id
        returning last_export_serial into v_serial;
        insert into payroll_exports (organization_id, serial_no, cycle_id, cycle_version, report_type, file_format, employee_count, exported_by)
        values (v_cycle.organization_id, v_serial, v_cycle.id, v_cycle.cycle_version, 'payslip', 'pdf', 1, v_me);
        v_docs := v_docs || jsonb_build_object('userId', v_emp ->> 'user_id', 'serial', v_serial);
    end loop;
    if jsonb_array_length(v_docs) = 0 then raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips'; end if;
    insert into payroll_export_jobs (organization_id, cycle_id, cycle_version, requested_by, total, documents)
    values (v_cycle.organization_id, v_cycle.id, v_cycle.cycle_version, v_me, jsonb_array_length(v_docs), v_docs)
    returning id into v_job;
    perform public.prosm_time_payroll_log(v_cycle.organization_id, 'payroll.bulk_export_started', 'payroll_export_jobs', v_job, null,
        'Bulk payslip export started', null,
        jsonb_build_object('cycleId', v_cycle.id, 'cycleVersion', v_cycle.cycle_version, 'count', jsonb_array_length(v_docs),
                           'serials', (select jsonb_agg(d -> 'serial') from jsonb_array_elements(v_docs) d)));
    return jsonb_build_object('success', true, 'jobId', v_job, 'total', jsonb_array_length(v_docs));
end;
$$;
revoke all on function public.start_prosm_time_payroll_export_job(uuid, uuid[]) from public, anon;
grant execute on function public.start_prosm_time_payroll_export_job(uuid, uuid[]) to authenticated;

-- The worker (service role): the next documents' payslip data, from the stored version only.
create or replace function public.prosm_time_payroll_export_batch(p_job_id uuid, p_from integer, p_count integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_job payroll_export_jobs%rowtype;
    v_cycle payroll_cycles%rowtype;
begin
    update payroll_export_jobs set status = 'running', heartbeat_at = now() where id = p_job_id and status in ('queued', 'running')
    returning * into v_job;
    if v_job.id is null then return null; end if;
    select * into v_cycle from payroll_cycles where id = v_job.cycle_id;
    return jsonb_build_object(
        'job', jsonb_build_object('id', v_job.id, 'organizationId', v_job.organization_id, 'total', v_job.total, 'done', v_job.done, 'cycleVersion', v_job.cycle_version),
        'organization', (select jsonb_build_object('name', name, 'logoUrl', logo_url) from organizations where id = v_job.organization_id),
        'timeZone', (select os.timezone from organization_settings os where os.organization_id = v_job.organization_id),
        'cycle', jsonb_build_object('title', v_cycle.title, 'periodStart', v_cycle.period_start, 'periodEnd', v_cycle.period_end),
        'settings', jsonb_build_object('taxNotice', v_cycle.policy_snapshot ->> 'tax_notice', 'footerNote', v_cycle.policy_snapshot ->> 'footer_note',
                                       'reportLanguage', coalesce(v_cycle.policy_snapshot ->> 'report_language', 'bilingual')),
        'documents', coalesce((
            select jsonb_agg(jsonb_build_object(
                'serial', (d.doc ->> 'serial')::bigint,
                'siteName', (select name from sites where id = nullif(e ->> 'site_id', '')::uuid),
                'employee', (e - 'lines') || jsonb_build_object('lines', coalesce((
                    select jsonb_agg(l order by (l ->> 'sort_order')::int, l ->> 'name_ar') from jsonb_array_elements(e -> 'lines') l
                    where (l ->> 'show_in_payslip')::boolean and (l ->> 'include_in_net')::boolean), '[]'::jsonb))
            ) order by d.ord)
            from jsonb_array_elements(v_job.documents) with ordinality d(doc, ord)
            join payroll_cycle_snapshots s on s.cycle_id = v_job.cycle_id and s.cycle_version = v_job.cycle_version
            cross join lateral jsonb_array_elements(s.data -> 'employees') e
            where (e ->> 'user_id') = (d.doc ->> 'userId') and d.ord > p_from and d.ord <= p_from + p_count
        ), '[]'::jsonb)
    );
end;
$$;

create or replace function public.prosm_time_payroll_export_progress(p_job_id uuid, p_done integer)
returns void
language sql
security definer
set search_path = public
as $$
    update payroll_export_jobs set done = greatest(done, p_done), heartbeat_at = now() where id = p_job_id and status = 'running';
$$;

create or replace function public.prosm_time_payroll_export_finish(p_job_id uuid, p_storage_path text, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_job payroll_export_jobs%rowtype;
    v_days integer;
begin
    select * into v_job from payroll_export_jobs where id = p_job_id for update;
    if v_job.id is null or v_job.status not in ('queued', 'running') then return; end if;
    select export_retention_days into v_days from payroll_settings where organization_id = v_job.organization_id;
    if p_error is null then
        update payroll_export_jobs set status = 'done', done = total, storage_path = p_storage_path, finished_at = now(),
            expires_at = now() + make_interval(days => coalesce(v_days, 7)), error = null where id = p_job_id;
    else
        update payroll_export_jobs set status = 'failed', storage_path = null, finished_at = now(), error = left(p_error, 500) where id = p_job_id;
    end if;
    perform public.prosm_time_payroll_log(v_job.organization_id, case when p_error is null then 'payroll.bulk_export_done' else 'payroll.bulk_export_failed' end,
        'payroll_export_jobs', p_job_id, null, case when p_error is null then 'Bulk payslip export ready' else 'Bulk payslip export failed' end, null,
        jsonb_build_object('cycleId', v_job.cycle_id, 'count', v_job.total, 'error', left(p_error, 200)));
end;
$$;

-- The sweep (service role): jobs that stopped beating, and files past their retention.
create or replace function public.prosm_time_payroll_export_sweep()
returns jsonb
language sql
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'resume', coalesce((select jsonb_agg(id) from payroll_export_jobs
                            where status in ('queued', 'running') and coalesce(heartbeat_at, created_at) < now() - interval '2 minutes'
                              and created_at > now() - interval '6 hours'), '[]'::jsonb),
        'stale', coalesce((select jsonb_agg(id) from payroll_export_jobs
                           where status in ('queued', 'running') and created_at <= now() - interval '6 hours'), '[]'::jsonb),
        'expired', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'path', storage_path)) from payroll_export_jobs
                             where status = 'done' and expires_at < now()), '[]'::jsonb));
$$;

create or replace function public.prosm_time_payroll_export_expired(p_job_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
    update payroll_export_jobs set status = 'expired', storage_path = null where id = p_job_id and status = 'done';
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array['public.prosm_time_payroll_export_batch(uuid, integer, integer)', 'public.prosm_time_payroll_export_progress(uuid, integer)',
        'public.prosm_time_payroll_export_finish(uuid, text, text)', 'public.prosm_time_payroll_export_sweep()', 'public.prosm_time_payroll_export_expired(uuid)'] loop
        execute format('revoke all on function %s from public, anon, authenticated', v_fn);
        execute format('grant execute on function %s to service_role', v_fn);
    end loop;
end $$;

-- The reader's jobs for a cycle (their own, or any in their export scope)
create or replace function public.list_prosm_time_payroll_export_jobs(p_cycle_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'status', j.status, 'total', j.total, 'done', j.done, 'cycleVersion', j.cycle_version,
                                                 'createdAt', j.created_at, 'finishedAt', j.finished_at, 'expiresAt', j.expires_at, 'error', j.error,
                                                 'mine', j.requested_by = public.current_prosm_time_user_id())
                              order by j.created_at desc), '[]'::jsonb)
    from payroll_export_jobs j join payroll_cycles c on c.id = j.cycle_id
    where j.cycle_id = p_cycle_id and j.organization_id = public.current_prosm_time_organization_id()
      and (j.requested_by = public.current_prosm_time_user_id() or public.prosm_time_payroll_allows('payroll.export_payslips', c.site_id));
$$;
revoke all on function public.list_prosm_time_payroll_export_jobs(uuid) from public, anon;
grant execute on function public.list_prosm_time_payroll_export_jobs(uuid) to authenticated;

-- A download: the permission is checked again every time; the Edge Function signs a short link.
create or replace function public.authorize_prosm_time_payroll_export_download(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_job payroll_export_jobs%rowtype;
begin
    select * into v_job from payroll_export_jobs where id = p_job_id and organization_id = public.current_prosm_time_organization_id();
    if v_job.id is null then raise exception 'EXPORT NOT FOUND'; end if;
    -- whoever started it, while they still hold the permission (the job was scoped when it started);
    -- anyone else, only with the permission over the cycle's whole scope
    if not (
        (v_job.requested_by = public.current_prosm_time_user_id()
         and (public.current_prosm_time_user_is_owner()
              or public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'payroll.export_payslips')
              or 'payroll.export_payslips' = any(public.prosm_time_delegated_permissions(public.current_prosm_time_user_id()))))
        or public.prosm_time_payroll_allows('payroll.export_payslips', (select site_id from payroll_cycles where id = v_job.cycle_id))
    ) or not public.prosm_time_plan_allows(v_job.organization_id, 'payroll') then
        raise exception 'PAYROLL AUTHORITY REQUIRED: payroll.export_payslips';
    end if;
    if v_job.status <> 'done' or v_job.storage_path is null or v_job.expires_at < now() then raise exception 'THIS EXPORT IS NOT AVAILABLE'; end if;
    perform public.prosm_time_payroll_log(v_job.organization_id, 'payroll.bulk_export_downloaded', 'payroll_export_jobs', v_job.id, null,
        'Bulk payslip export downloaded', null, jsonb_build_object('cycleId', v_job.cycle_id));
    return jsonb_build_object('path', v_job.storage_path, 'cycleVersion', v_job.cycle_version);
end;
$$;
revoke all on function public.authorize_prosm_time_payroll_export_download(uuid) from public, anon;
grant execute on function public.authorize_prosm_time_payroll_export_download(uuid) to authenticated;

-- every 5 minutes: resume stopped jobs and delete expired files (skipped while the vault key is missing)
do $$
begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'prosm-time-payroll-export-sweep';
exception
    when undefined_table then null;
end $$;
select cron.schedule('prosm-time-payroll-export-sweep', '*/5 * * * *', $cron$
    select net.http_post(
        url := 'https://wcfdhsxzeryqwpmftgay.supabase.co/functions/v1/payroll-export-job',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'prosm_time_service_role_key' limit 1)
        ),
        body := '{"action": "sweep"}'::jsonb
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'prosm_time_service_role_key');
$cron$);

commit;
