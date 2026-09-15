-- PROSM Time - user-reported real gap (#4, 2026-09-15): "كشوف الدوام
-- عايزه لما يصدر يروح يتحفظ في التقارير عشان اقدر اسحبه في اي وقت" -
-- every PDF export in this app (attendance log, allowances, timesheet,
-- and all 8 generic Reports Center types) was a purely client-side
-- jsPDF generation immediately handed to the browser's own download -
-- nothing was ever persisted server-side. If the Owner/manager didn't
-- save the file the moment it was generated, it was gone for good.
--
-- Architecture mirrors camera_evidence (20260831190000) exactly - a
-- metadata table + a private storage bucket, upload authorized
-- directly against the caller's own organization (no join-back needed
-- here, unlike evidence's attendance_event_id path segment, since
-- there's no pre-existing row an export is "attached to" - the export
-- itself is the row). record_prosm_time_report_export() re-validates
-- the same organization scoping as the storage policy, same defense-
-- in-depth posture as attach_prosm_time_camera_evidence().
--
-- Wired into ONE choke point (savePdfDocument.ts) rather than each of
-- the ~6 individual export call sites separately - every current and
-- future PDF export in this app gets archived automatically.

begin;

create table public.report_exports (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    exported_by uuid not null references public.users(id) on delete cascade,
    report_type text not null,
    period_start date,
    period_end date,
    file_name text not null,
    storage_path text not null unique,
    created_at timestamptz not null default now()
);

create index report_exports_organization_id_idx on public.report_exports(organization_id, created_at desc);
create index report_exports_exported_by_idx on public.report_exports(exported_by);

-- ============================================================
-- RLS - the exporter always sees their own archived exports (an
-- employee's own single-timesheet PDF, say); org-wide visibility of
-- every export requires the same management scope Reports Center
-- itself already gates on (Owner, or 'exceptions.manage').
-- ============================================================

alter table public.report_exports enable row level security;

revoke all on public.report_exports from anon, authenticated;
grant select on public.report_exports to authenticated;

create policy "report exports visible to exporter or management scope"
on public.report_exports for select to authenticated
using (
    exported_by = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- ============================================================
-- Private storage bucket. Path convention:
-- {organization_id}/{export_id}-{filename} - the organization segment
-- is directly derivable from the caller's own session (no join-back
-- needed, unlike camera-evidence's attendance_event_id lookup).
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-exports', 'report-exports', false, 20971520, array['application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "org members can upload their own organization report exports"
on storage.objects for insert to authenticated
with check (
    bucket_id = 'report-exports'
    and (storage.foldername(name))[1] = public.current_prosm_time_organization_id()::text
);

create policy "report export files visible to exporter or management scope"
on storage.objects for select to authenticated
using (
    bucket_id = 'report-exports'
    and exists (
        select 1 from public.report_exports re
        where re.storage_path = storage.objects.name
        and (
            re.exported_by = public.current_prosm_time_user_id()
            or (
                re.organization_id = public.current_prosm_time_organization_id()
                and (
                    public.current_prosm_time_user_is_owner()
                    or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                )
            )
        )
    )
);

-- ============================================================
-- record_prosm_time_report_export() - records the metadata row after
-- a successful direct-to-storage upload. Re-validates the same
-- organization scoping the storage policy already enforced (defense
-- in depth, same posture as attach_prosm_time_camera_evidence).
-- ============================================================

create or replace function public.record_prosm_time_report_export(
    p_report_type text,
    p_file_name text,
    p_storage_path text,
    p_period_start date default null,
    p_period_end date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_export_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_report_type is null or length(trim(p_report_type)) = 0 then
        raise exception 'REPORT TYPE IS REQUIRED';
    end if;
    if p_file_name is null or length(trim(p_file_name)) = 0 then
        raise exception 'FILE NAME IS REQUIRED';
    end if;
    if p_storage_path is null or (storage.foldername(p_storage_path))[1] <> v_caller_org::text then
        raise exception 'STORAGE PATH DOES NOT BELONG TO YOUR ORGANIZATION';
    end if;

    insert into report_exports (organization_id, exported_by, report_type, period_start, period_end, file_name, storage_path)
    values (v_caller_org, v_caller_id, p_report_type, p_period_start, p_period_end, p_file_name, p_storage_path)
    returning id into v_export_id;

    return jsonb_build_object('success', true, 'exportId', v_export_id);
exception
    when unique_violation then
        raise exception 'THIS STORAGE PATH IS ALREADY ARCHIVED';
    when others then
        raise exception 'RECORD PROSM TIME REPORT EXPORT FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.record_prosm_time_report_export(text, text, text, date, date) to authenticated;

-- ============================================================
-- list_prosm_time_report_exports() - the archive's own read surface,
-- same RLS-scoped select the table's own policy already allows -
-- exists as a function purely so the client can order/limit without
-- a separate PostgREST query shape per caller.
-- ============================================================

create or replace function public.list_prosm_time_report_exports(p_limit int default 50)
returns table (
    id uuid,
    report_type text,
    period_start date,
    period_end date,
    file_name text,
    storage_path text,
    exported_by_name text,
    created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $function$
    select re.id, re.report_type, re.period_start, re.period_end, re.file_name, re.storage_path, u.full_name, re.created_at
    from report_exports re
    join users u on u.id = re.exported_by
    where re.exported_by = public.current_prosm_time_user_id()
       or (
            re.organization_id = public.current_prosm_time_organization_id()
            and (
                public.current_prosm_time_user_is_owner()
                or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
            )
       )
    order by re.created_at desc
    limit p_limit;
$function$;

grant execute on function public.list_prosm_time_report_exports(int) to authenticated;

commit;
