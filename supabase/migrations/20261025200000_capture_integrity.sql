-- PROSM Time v2.3.43, step 11 (item 22): make it hard to show a still
-- photo instead of a live face, and finish the tampering signals. This is
-- NOT face recognition: no face template is kept, no matching is done, no
-- video leaves the phone. Nothing here blocks a clock in/out (except the
-- organisation's existing "reject fake location" setting): every signal
-- becomes an integrity flag for a manager to accept, reject or ask about.
--   a) live capture: a photo picked from a file (the fallback when the camera
--      cannot open) is marked capture_source = 'file_fallback' and flagged;
--   b) one-time capture token issued by the server before the photo; a photo
--      tied to a used token or older than the site's limit (2 minutes by
--      default) is flagged;
--   c) liveness challenge per site: OFF (default) | RANDOM (25% by default)
--      | ALWAYS; two failures by the same person in a day turn it to ALWAYS
--      for the rest of that day; the result kept is passed / failed /
--      unavailable + the challenge + a confidence; a manager can exempt a
--      person with a recorded reason (accessibility);
--   d) server-side checks on every clock in/out: the same coordinates again
--      with a near-zero accuracy, and a suspicious "perfect" accuracy -
--      besides the existing impossible-speed and fake-location flags.
-- Permissions: sites.manage_integrity (the site's setting, the Owner by
-- default), attendance.review_integrity_flags (Owner, Managers at their sites).

begin;

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('sites.manage_integrity', 'sites', 'ADMINISTER', 'Liveness and tamper settings', 'Set the liveness challenge and photo age of a site; exempt a person from the challenge.'),
    ('attendance.review_integrity_flags', 'attendance', 'APPROVE', 'Review suspicious check-ins', 'Accept, reject or ask about suspicious check-ins of people at the sites one manages.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'sites.manage_integrity'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'attendance.review_integrity_flags'
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

alter table public.sites add column if not exists liveness_mode text not null default 'OFF';
alter table public.sites drop constraint if exists sites_liveness_mode_check;
alter table public.sites add constraint sites_liveness_mode_check check (liveness_mode in ('OFF', 'RANDOM', 'ALWAYS'));
alter table public.sites add column if not exists liveness_random_percent integer not null default 25 check (liveness_random_percent between 1 and 100);
alter table public.sites add column if not exists capture_max_age_seconds integer not null default 120 check (capture_max_age_seconds between 30 and 3600);

alter table public.users add column if not exists liveness_exempt boolean not null default false;
alter table public.users add column if not exists liveness_exempt_reason text;

alter table public.camera_evidence add column if not exists capture_source text;
alter table public.camera_evidence add column if not exists capture_token_id uuid;
alter table public.camera_evidence add column if not exists liveness_result text;
alter table public.camera_evidence add column if not exists liveness_challenge text;
alter table public.camera_evidence add column if not exists liveness_confidence numeric;
alter table public.camera_evidence drop constraint if exists camera_evidence_capture_source_check;
alter table public.camera_evidence add constraint camera_evidence_capture_source_check check (capture_source is null or capture_source in ('live_camera', 'file_fallback'));
alter table public.camera_evidence drop constraint if exists camera_evidence_liveness_result_check;
alter table public.camera_evidence add constraint camera_evidence_liveness_result_check check (liveness_result is null or liveness_result in ('passed', 'failed', 'unavailable', 'not_required'));

create table if not exists public.capture_tokens (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    challenge text,
    challenge_required boolean not null default false,
    issued_at timestamptz not null default now(),
    used_at timestamptz,
    attendance_event_id uuid references public.attendance_events(id) on delete set null
);
create index if not exists capture_tokens_user_idx on public.capture_tokens (user_id, issued_at desc);

alter table public.capture_tokens enable row level security;
revoke all on public.capture_tokens from anon, authenticated;

create table if not exists public.integrity_flags (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    attendance_event_id uuid references public.attendance_events(id) on delete cascade,
    kind text not null check (kind in ('liveness_failed', 'liveness_unavailable', 'unverified_capture', 'stale_capture', 'reused_token',
                                       'missing_token', 'repeated_coordinates', 'suspicious_accuracy')),
    details jsonb not null default '{}'::jsonb,
    status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected', 'clarification_requested')),
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    review_notes text,
    created_at timestamptz not null default now()
);
create index if not exists integrity_flags_pending_idx on public.integrity_flags (organization_id) where status = 'pending_review';

alter table public.integrity_flags enable row level security;
revoke all on public.integrity_flags from anon, authenticated;
grant select on public.integrity_flags to authenticated;
drop policy if exists "integrity flags visible to the person or their reviewers" on public.integrity_flags;
create policy "integrity flags visible to the person or their reviewers" on public.integrity_flags
for select to authenticated using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id = public.current_prosm_time_user_id() or public.prosm_time_caller_sees_person(user_id))
);

create or replace function public.prosm_time_flag_integrity(p_organization_id uuid, p_user_id uuid, p_site_id uuid, p_event_id uuid, p_kind text, p_details jsonb)
returns void
language sql
security definer
set search_path = public
as $function$
    insert into integrity_flags (organization_id, user_id, site_id, attendance_event_id, kind, details)
    values (p_organization_id, p_user_id, p_site_id, p_event_id, p_kind, coalesce(p_details, '{}'::jsonb));
$function$;

revoke all on function public.prosm_time_flag_integrity(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- b) + c) the token and the challenge, decided by the server.
-- ------------------------------------------------------------------
create or replace function public.issue_prosm_time_capture_token(p_site_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_site sites%rowtype;
    v_mode text := 'OFF';
    v_required boolean := false;
    v_failures integer;
    v_challenge text;
    v_id uuid;
    v_tz text;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_site_id is not null then
        select * into v_site from sites where id = p_site_id and organization_id = v_org;
        v_mode := coalesce(v_site.liveness_mode, 'OFF');
    end if;
    v_tz := public.prosm_time_site_timezone(p_site_id, v_org);

    select count(*) into v_failures from integrity_flags
    where user_id = v_caller and kind = 'liveness_failed'
      and (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date;

    if coalesce((select liveness_exempt from users where id = v_caller), false) then
        v_required := false;
    elsif v_failures >= 2 or v_mode = 'ALWAYS' then
        v_required := true;
    elsif v_mode = 'RANDOM' then
        v_required := random() * 100 < coalesce(v_site.liveness_random_percent, 25);
    end if;

    if v_required then
        v_challenge := (array['turn_left', 'turn_right', 'move_closer'])[1 + floor(random() * 3)::int];
    end if;

    insert into capture_tokens (organization_id, user_id, site_id, challenge, challenge_required)
    values (v_org, v_caller, p_site_id, v_challenge, v_required)
    returning id into v_id;

    return jsonb_build_object('token', v_id, 'issuedAt', now(), 'challengeRequired', v_required, 'challenge', v_challenge,
                              'maxAgeSeconds', coalesce(v_site.capture_max_age_seconds, 120), 'escalated', v_failures >= 2);
end;
$function$;

revoke all on function public.issue_prosm_time_capture_token(uuid) from public, anon;
grant execute on function public.issue_prosm_time_capture_token(uuid) to authenticated;

-- After the photo is attached: record how it was captured, and flag what
-- needs a look. Never blocks.
create or replace function public.record_prosm_time_capture_integrity(
    p_attendance_event_id uuid,
    p_token uuid,
    p_capture_source text,
    p_liveness_result text,
    p_challenge text default null,
    p_confidence numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_event attendance_events%rowtype;
    v_session attendance_sessions%rowtype;
    v_token capture_tokens%rowtype;
    v_max_age integer;
    v_flags text[] := array[]::text[];
    v_result text := coalesce(p_liveness_result, 'not_required');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_capture_source not in ('live_camera', 'file_fallback') then raise exception 'INVALID CAPTURE SOURCE'; end if;
    if v_result not in ('passed', 'failed', 'unavailable', 'not_required') then raise exception 'INVALID LIVENESS RESULT'; end if;

    select * into v_event from attendance_events where id = p_attendance_event_id and user_id = v_caller;
    if v_event.id is null then raise exception 'ATTENDANCE EVENT NOT FOUND'; end if;
    select * into v_session from attendance_sessions where id = v_event.session_id;

    if p_token is null then
        v_flags := array_append(v_flags, 'missing_token');
    else
        select * into v_token from capture_tokens where id = p_token and user_id = v_caller for update;
        if v_token.id is null then
            v_flags := array_append(v_flags, 'missing_token');
        elsif v_token.used_at is not null then
            v_flags := array_append(v_flags, 'reused_token');
        else
            select coalesce(capture_max_age_seconds, 120) into v_max_age from sites where id = v_token.site_id;
            if now() - v_token.issued_at > make_interval(secs => coalesce(v_max_age, 120)) then
                v_flags := array_append(v_flags, 'stale_capture');
            end if;
            update capture_tokens set used_at = now(), attendance_event_id = p_attendance_event_id where id = p_token;
            -- a challenge the server asked for counts as failed if the app skipped it
            if v_token.challenge_required and v_result = 'not_required' then v_result := 'failed'; end if;
        end if;
    end if;

    if p_capture_source = 'file_fallback' then v_flags := array_append(v_flags, 'unverified_capture'); end if;
    if v_result = 'failed' then v_flags := array_append(v_flags, 'liveness_failed'); end if;
    if v_result = 'unavailable' and coalesce(v_token.challenge_required, false) then v_flags := array_append(v_flags, 'liveness_unavailable'); end if;

    update camera_evidence set capture_source = p_capture_source, capture_token_id = p_token, liveness_result = v_result,
        liveness_challenge = coalesce(p_challenge, v_token.challenge), liveness_confidence = p_confidence
    where attendance_event_id = p_attendance_event_id and user_id = v_caller;

    insert into integrity_flags (organization_id, user_id, site_id, attendance_event_id, kind, details)
    select v_session.organization_id, v_caller, v_session.site_id, p_attendance_event_id, flag,
           jsonb_build_object('challenge', coalesce(p_challenge, v_token.challenge), 'confidence', p_confidence, 'captureSource', p_capture_source,
                              'tokenIssuedAt', v_token.issued_at, 'eventType', v_event.event_type)
    from unnest(v_flags) flag;

    return jsonb_build_object('success', true, 'flags', to_jsonb(v_flags), 'livenessResult', v_result);
end;
$function$;

revoke all on function public.record_prosm_time_capture_integrity(uuid, uuid, text, text, text, numeric) from public, anon;
grant execute on function public.record_prosm_time_capture_integrity(uuid, uuid, text, text, text, numeric) to authenticated;

-- ------------------------------------------------------------------
-- d) coordinates: the same point again with ~zero accuracy; a "perfect" accuracy.
-- ------------------------------------------------------------------
create or replace function public.prosm_time_check_event_coordinates()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_previous attendance_events%rowtype;
    v_session attendance_sessions%rowtype;
begin
    if new.latitude is null or new.longitude is null or new.recorded_by is not null then return new; end if;
    select * into v_session from attendance_sessions where id = new.session_id;
    if new.accuracy_meters is not null and new.accuracy_meters < 1 then
        perform public.prosm_time_flag_integrity(v_session.organization_id, new.user_id, v_session.site_id, new.id, 'suspicious_accuracy',
            jsonb_build_object('accuracyMeters', new.accuracy_meters, 'eventType', new.event_type));
    end if;
    -- the exact same point again (last 30 days), both with ~zero accuracy: a typical fake-GPS signature
    select * into v_previous from attendance_events
    where user_id = new.user_id and id <> new.id and occurred_at < new.occurred_at and occurred_at > new.occurred_at - interval '30 days'
      and latitude = new.latitude and longitude = new.longitude and coalesce(accuracy_meters, 0) <= 1
    order by occurred_at desc limit 1;
    if v_previous.id is not null and coalesce(new.accuracy_meters, 0) <= 1 then
        perform public.prosm_time_flag_integrity(v_session.organization_id, new.user_id, v_session.site_id, new.id, 'repeated_coordinates',
            jsonb_build_object('latitude', new.latitude, 'longitude', new.longitude, 'previousEventId', v_previous.id));
    end if;
    return new;
end;
$function$;

revoke all on function public.prosm_time_check_event_coordinates() from public, anon, authenticated;

drop trigger if exists attendance_events_check_coordinates on public.attendance_events;
create trigger attendance_events_check_coordinates
after insert on public.attendance_events
for each row execute function public.prosm_time_check_event_coordinates();

-- ------------------------------------------------------------------
-- Settings, exemptions, review, queue.
-- ------------------------------------------------------------------
create or replace function public.set_prosm_time_site_integrity(p_site_id uuid, p_liveness_mode text, p_random_percent integer, p_max_age_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_site sites%rowtype;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_site from sites where id = p_site_id and organization_id = public.current_prosm_time_organization_id();
    if v_site.id is null then raise exception 'SITE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(v_caller, 'sites.manage_integrity') and p_site_id = any(public.current_prosm_time_managed_site_ids()))
    ) then
        raise exception 'SITES.MANAGE_INTEGRITY AUTHORITY REQUIRED';
    end if;
    if p_liveness_mode not in ('OFF', 'RANDOM', 'ALWAYS') then raise exception 'INVALID LIVENESS MODE'; end if;
    begin
        update sites set liveness_mode = p_liveness_mode, liveness_random_percent = coalesce(p_random_percent, liveness_random_percent),
            capture_max_age_seconds = coalesce(p_max_age_seconds, capture_max_age_seconds), updated_at = now()
        where id = p_site_id;
    exception when check_violation then raise exception 'INVALID LIVENESS MODE';
    end;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, entity_id, description, previous_state, new_state)
    values (v_site.organization_id, v_caller, 'sites.integrity_settings', 'sites', p_site_id, 'Liveness / photo settings changed',
            jsonb_build_object('mode', v_site.liveness_mode, 'randomPercent', v_site.liveness_random_percent, 'maxAgeSeconds', v_site.capture_max_age_seconds),
            jsonb_build_object('mode', p_liveness_mode, 'randomPercent', p_random_percent, 'maxAgeSeconds', p_max_age_seconds));
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.set_prosm_time_liveness_exemption(p_user_id uuid, p_exempt boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not exists (select 1 from users where id = p_user_id and organization_id = public.current_prosm_time_organization_id()) then raise exception 'EMPLOYEE NOT FOUND'; end if;
    if not (
        public.current_prosm_time_user_is_owner()
        or ((public.prosm_time_user_has_permission_internal(v_caller, 'sites.manage_integrity') or public.prosm_time_user_has_permission_internal(v_caller, 'attendance.review_integrity_flags'))
            and public.prosm_time_caller_has_authority_over(p_user_id))
    ) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;
    if coalesce(p_exempt, false) and v_reason is null then raise exception 'A REASON IS REQUIRED'; end if;
    update users set liveness_exempt = coalesce(p_exempt, false), liveness_exempt_reason = case when coalesce(p_exempt, false) then v_reason else null end, updated_at = now()
    where id = p_user_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, new_state)
    values (public.current_prosm_time_organization_id(), v_caller, p_user_id, 'attendance.liveness_exemption', 'users', p_user_id,
            'Liveness challenge exemption changed', v_reason, jsonb_build_object('exempt', coalesce(p_exempt, false)));
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.review_prosm_time_integrity_flag(p_flag_id uuid, p_action text, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_flag integrity_flags%rowtype;
    v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_flag from integrity_flags where id = p_flag_id and organization_id = public.current_prosm_time_organization_id() for update;
    if v_flag.id is null then raise exception 'REVIEW ITEM NOT FOUND'; end if;
    if not public.prosm_time_user_has_permission_internal(v_caller, 'attendance.review_integrity_flags') then
        raise exception 'ATTENDANCE.REVIEW_INTEGRITY_FLAGS AUTHORITY REQUIRED';
    end if;
    if v_flag.user_id = v_caller then raise exception 'YOU CANNOT REVIEW YOUR OWN SHIFT'; end if;
    if not public.prosm_time_caller_has_authority_over(v_flag.user_id) then raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE'; end if;
    if p_action not in ('approved', 'rejected', 'clarification_requested') then raise exception 'INVALID ACTION TYPE'; end if;
    if p_action in ('rejected', 'clarification_requested') and v_notes is null then raise exception 'A REASON IS REQUIRED'; end if;
    update integrity_flags set status = p_action, reviewed_by = v_caller, reviewed_at = now(), review_notes = v_notes where id = p_flag_id;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, reason, previous_state, new_state)
    values (v_flag.organization_id, v_caller, v_flag.user_id, 'attendance.integrity_' || p_action, 'integrity_flags', p_flag_id,
            'Suspicious check-in reviewed', v_notes, jsonb_build_object('status', v_flag.status, 'kind', v_flag.kind), jsonb_build_object('status', p_action));
    perform public.create_prosm_time_notification(
        v_flag.organization_id, v_flag.user_id, 'correction_reviewed', 'normal', 'Your check-in was reviewed',
        'Decision: ' || p_action || '.', 'integrity_flags', p_flag_id,
        jsonb_build_object('kind', 'integrity', 'actionType', p_action) || case when v_notes is not null then jsonb_build_object('notes', v_notes) else '{}'::jsonb end
    );
    return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.list_prosm_time_integrity_flags(p_status text default 'pending_review')
returns table (id uuid, user_id uuid, employee_name text, avatar_url text, site_name text, attendance_event_id uuid, kind text, details jsonb,
               status text, created_at timestamptz, occurred_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
    if public.current_prosm_time_user_id() is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'attendance.review_integrity_flags') then return; end if;
    return query
    select f.id, f.user_id, u.full_name, u.avatar_url, s.name, f.attendance_event_id, f.kind, f.details, f.status, f.created_at, e.occurred_at
    from integrity_flags f
    join users u on u.id = f.user_id
    left join sites s on s.id = f.site_id
    left join attendance_events e on e.id = f.attendance_event_id
    where f.organization_id = public.current_prosm_time_organization_id()
      and f.status = coalesce(p_status, f.status)
      and f.user_id <> public.current_prosm_time_user_id()
      and public.prosm_time_caller_has_authority_over(f.user_id)
    order by f.created_at;
end;
$function$;

revoke all on function public.set_prosm_time_site_integrity(uuid, text, integer, integer) from public, anon;
revoke all on function public.set_prosm_time_liveness_exemption(uuid, boolean, text) from public, anon;
revoke all on function public.review_prosm_time_integrity_flag(uuid, text, text) from public, anon;
revoke all on function public.list_prosm_time_integrity_flags(text) from public, anon;
grant execute on function public.set_prosm_time_site_integrity(uuid, text, integer, integer) to authenticated;
grant execute on function public.set_prosm_time_liveness_exemption(uuid, boolean, text) to authenticated;
grant execute on function public.review_prosm_time_integrity_flag(uuid, text, text) to authenticated;
grant execute on function public.list_prosm_time_integrity_flags(text) to authenticated;

-- The dashboard counts suspicious check-ins waiting too.
do $$
declare
    v_def text;
    v_anchor constant text := 'union all select user_id from attendance_permissions where organization_id = v_org and status = ''pending''';
begin
    v_def := pg_get_functiondef('public.get_prosm_time_dashboard_summary(date, text)'::regprocedure);
    if position(v_anchor in v_def) = 0 then raise exception 'get_prosm_time_dashboard_summary changed - permissions line not found'; end if;
    execute replace(v_def, v_anchor, v_anchor || chr(10) || '        union all select user_id from integrity_flags where organization_id = v_org and status = ''pending_review''');
end;
$$;

commit;
