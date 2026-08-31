-- PROSM Time Implementation Master File V3.0, WP-08 (§16 "Attendance
-- Evidence (Camera)"). Scope per §38's own row: "Capture, private
-- storage, evidence linkage and retention." §16's own requirements:
-- evidence must be privately stored, access-controlled (signed/
-- authorized access), linked to the attendance event, auditable, and
-- subject to retention/deletion policy. No face recognition/biometric
-- treatment in V1.
--
-- Architecture matches PROSM Platform's own proven private-bucket +
-- storage.objects RLS pattern (ai_message_attachments,
-- 20260811130100) exactly, rather than routing every upload/read
-- through an Edge Function - notably, §35's own explicit list of
-- Edge-Function-mediated flows ("Clock In, Clock Out, geofence
-- validation, exception actions, break events, correction requests,
-- SOS alerts, administrative on-behalf actions") does not include
-- evidence capture, so this is the correct boundary, not a shortcut.
-- The client uploads directly to the private bucket (authorized by a
-- real storage.objects policy keyed on the attendance_event_id path
-- segment), then calls attach_prosm_time_camera_evidence() to record
-- the linkage/audit row.

-- ============================================================
-- 1. camera_evidence - metadata only; the real image bytes live in
--    the private bucket below. Linked to exactly one attendance_event
--    (§16: "associate evidence with the attendance event").
-- ============================================================

create table public.camera_evidence (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    attendance_event_id uuid not null references public.attendance_events(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    storage_path text not null unique,
    content_type text not null,
    file_size_bytes integer,
    captured_at timestamptz not null default now(),
    -- Retention-policy foundation (§16: "subject to retention/deletion
    -- policy"): a real, computed expiry every row gets by default - not
    -- yet an admin-configurable per-organization setting (no such
    -- setting exists anywhere in this schema to hang it off), and
    -- automatic scheduled purging is real future scope, not built this
    -- pass (see purge-camera-evidence's own header comment) - the same
    -- "field exists and is checkable, automatic enforcement is a
    -- separate pass" distinction already established for Platform's
    -- own retention-adjacent work.
    retention_expires_at timestamptz not null default (now() + interval '90 days'),
    created_at timestamptz not null default now()
);

create index camera_evidence_organization_id_idx on public.camera_evidence(organization_id);
create index camera_evidence_attendance_event_id_idx on public.camera_evidence(attendance_event_id);
create index camera_evidence_user_id_idx on public.camera_evidence(user_id);
create index camera_evidence_retention_expires_at_idx on public.camera_evidence(retention_expires_at);

-- ============================================================
-- 2. RLS - metadata visibility mirrors attendance_events exactly: the
--    subject always sees their own; org-wide visibility requires the
--    real 'attendance.view' permission (or Owner). All writes go
--    through attach_prosm_time_camera_evidence() below - no direct
--    insert/update/delete grant to authenticated.
-- ============================================================

alter table public.camera_evidence enable row level security;

revoke all on public.camera_evidence from anon, authenticated;
grant select on public.camera_evidence to authenticated;

create policy "camera evidence visible to subject or attendance.view"
on public.camera_evidence for select to authenticated
using (
    user_id = public.current_prosm_time_user_id()
    or (
        organization_id = public.current_prosm_time_organization_id()
        and (
            public.current_prosm_time_user_is_owner()
            or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
        )
    )
);

-- ============================================================
-- 3. Private storage bucket. Path convention:
--    attendance-events/{attendance_event_id}/{filename} - the same
--    "id as folder segment, checked via a real join back to the
--    owning row" shape as Platform's own ai-attachments bucket.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('camera-evidence', 'camera-evidence', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Upload is authorized only for the event's own subject (self-capture,
-- WP-06) or the administrator who recorded it on their behalf (WP-07)
-- - never a third party, and never the employee for an event they
-- didn't perform themselves.
create policy "event subject or on-behalf actor can upload camera evidence"
on storage.objects for insert to authenticated
with check (
    bucket_id = 'camera-evidence'
    and (storage.foldername(name))[1] = 'attendance-events'
    and exists (
        select 1 from public.attendance_events e
        where e.id = ((storage.foldername(name))[2])::uuid
        and (e.user_id = public.current_prosm_time_user_id() or e.recorded_by = public.current_prosm_time_user_id())
    )
);

-- Download is authorized for the event's own subject, the on-behalf
-- actor who captured it, or any org member with 'attendance.view'
-- (or Owner) - the same visibility rule as the metadata table above.
create policy "event subject, on-behalf actor, or attendance.view can read camera evidence"
on storage.objects for select to authenticated
using (
    bucket_id = 'camera-evidence'
    and (storage.foldername(name))[1] = 'attendance-events'
    and exists (
        select 1 from public.attendance_events e
        join public.attendance_sessions s on s.id = e.session_id
        where e.id = ((storage.foldername(name))[2])::uuid
        and (
            e.user_id = public.current_prosm_time_user_id()
            or e.recorded_by = public.current_prosm_time_user_id()
            or (
                s.organization_id = public.current_prosm_time_organization_id()
                and (
                    public.current_prosm_time_user_is_owner()
                    or 'attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(public.current_prosm_time_user_id()), array[]::text[]))
                )
            )
        )
    )
);

-- ============================================================
-- 4. attach_prosm_time_camera_evidence() - records the linkage/audit
--    row after a successful direct-to-storage upload. Re-validates
--    the exact same authorization the storage policy already
--    enforced (defense in depth, matching this codebase's own
--    established posture) - the storage upload succeeding is not
--    trusted as proof of authorization on its own.
-- ============================================================

create or replace function public.attach_prosm_time_camera_evidence(
    p_attendance_event_id uuid,
    p_storage_path text,
    p_content_type text,
    p_file_size_bytes integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_event attendance_events%rowtype;
    v_organization_id uuid;
    v_evidence_id uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if p_storage_path is null or length(trim(p_storage_path)) = 0 then
        raise exception 'STORAGE PATH IS REQUIRED';
    end if;

    select * into v_event from attendance_events where id = p_attendance_event_id;
    if v_event.id is null then
        raise exception 'ATTENDANCE EVENT NOT FOUND';
    end if;

    if not (v_event.user_id = v_caller_id or v_event.recorded_by = v_caller_id) then
        raise exception 'YOU ARE NOT AUTHORIZED TO ATTACH EVIDENCE TO THIS EVENT';
    end if;

    select organization_id into v_organization_id from attendance_sessions where id = v_event.session_id;

    insert into camera_evidence (organization_id, attendance_event_id, user_id, storage_path, content_type, file_size_bytes)
    values (v_organization_id, p_attendance_event_id, v_event.user_id, p_storage_path, p_content_type, p_file_size_bytes)
    returning id into v_evidence_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
    values (
        v_organization_id, v_caller_id, v_event.user_id, 'CAMERA_EVIDENCE_ATTACHED', 'camera_evidence', v_evidence_id,
        'Camera evidence attached to a ' || v_event.event_type || ' event.',
        jsonb_build_object('attendanceEventId', p_attendance_event_id, 'storagePath', p_storage_path)
    );

    return jsonb_build_object('success', true, 'evidenceId', v_evidence_id);
exception
    when unique_violation then
        raise exception 'THIS STORAGE PATH IS ALREADY LINKED TO EVIDENCE';
    when others then
        raise exception 'ATTACH PROSM TIME CAMERA EVIDENCE FAILED: %', sqlerrm;
end;
$function$;

grant execute on function public.attach_prosm_time_camera_evidence(uuid, text, text, integer) to authenticated;

-- ============================================================
-- 5. Retention-policy foundation: real, callable, service_role-only
--    RPCs that identify and remove expired evidence rows -
--    purge-camera-evidence (the Edge Function) is what actually calls
--    these and deletes the matching storage object; no automatic
--    schedule is wired up this pass (real future scope, e.g. a
--    pg_cron trigger, deliberately not built here - see this
--    migration's own header comment).
-- ============================================================

create or replace function public.list_expired_prosm_time_camera_evidence()
returns table (id uuid, storage_path text)
language sql
security definer
set search_path = public
as $function$
    select id, storage_path from camera_evidence where retention_expires_at <= now();
$function$;

create or replace function public.delete_prosm_time_camera_evidence_record(p_evidence_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
    delete from camera_evidence where id = p_evidence_id;
    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'DELETE PROSM TIME CAMERA EVIDENCE RECORD FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.list_expired_prosm_time_camera_evidence() from public, anon, authenticated;
revoke execute on function public.delete_prosm_time_camera_evidence_record(uuid) from public, anon, authenticated;
grant execute on function public.list_expired_prosm_time_camera_evidence() to service_role;
grant execute on function public.delete_prosm_time_camera_evidence_record(uuid) to service_role;
