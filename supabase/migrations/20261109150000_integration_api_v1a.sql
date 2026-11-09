-- 2026-11-09 integration API v1a (spec 17.5): more to read, and attendance received through the API.
--   * New scopes: shifts:read and attendance:write.
--   * Read: shifts in a window, and leave balances (the same entitlement rule the app uses).
--   * Write: attendance events (clock in / clock out) from another system - a fingerprint device,
--     an HR system. Each event carries the sender's own id (externalId): sending it again changes
--     nothing (idempotent); the same id with different content is refused as a conflict.
--   * Imported events enter as pending (spec 17.3 item 6): they feed nothing - not payroll, not the
--     dashboard, not leave - until a manager approves them in the app. Approving pairs each clock-in
--     with the next clock-out of the same person into a normal attendance record (time source
--     "imported"), audited; overlaps and unpaired events stay pending with the reason.
--   * External workers stay out of the API (spec 17.3 item 8).

begin;

create or replace function public.prosm_time_api_scopes()
returns text[]
language sql
immutable
set search_path = public
as $$
    select array['employees:read', 'employees:read_sensitive', 'sites:read', 'attendance:read', 'attendance:write', 'leaves:read', 'shifts:read', 'payroll:read'];
$$;

alter table public.attendance_events drop constraint if exists attendance_events_time_source_check;
alter table public.attendance_events add constraint attendance_events_time_source_check
    check (time_source in ('server', 'device_offline', 'auto_closed', 'auto_geofence', 'admin_set', 'imported'));

-- Read: shifts --------------------------------------------------------------------------------
create or replace function public.api_v1_shifts(p_org uuid, p_since date, p_until date, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'id')), '[]'::jsonb) from (
        select jsonb_build_object('id', sa.id, 'employeeId', sa.user_id, 'siteId', sa.site_id, 'date', sa.shift_date,
                                  'startTime', to_char(sa.start_time, 'HH24:MI'), 'endTime', to_char(sa.end_time, 'HH24:MI'), 'status', sa.status) as row
        from shift_assignments sa
        where sa.organization_id = p_org and sa.shift_date between p_since and p_until and (p_after is null or sa.id > p_after)
        order by sa.id limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x;
$$;

-- Read: leave balances (per employee, per active leave type, for a year) -----------------------
create or replace function public.api_v1_leave_balances(p_org uuid, p_year integer, p_after uuid, p_limit integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(row order by (row ->> 'employeeId')), '[]'::jsonb) from (
        select jsonb_build_object('employeeId', u.id, 'year', p_year, 'balances', coalesce((
            select jsonb_agg(jsonb_build_object(
                'leaveType', lt.key, 'name', lt.name, 'paid', lt.is_paid,
                'entitledDays', e.ent -> 'entitled',
                'usedDays', e.used, 'pendingDays', e.pending,
                'remainingDays', case when jsonb_typeof(e.ent -> 'entitled') in ('number', 'string') then (e.ent ->> 'entitled')::numeric - e.used - e.pending end
            ) order by lt.sort_order, lt.name)
            from leave_types lt
            cross join lateral (
                select public.prosm_time_leave_entitlement(u.id, lt, p_year) as ent,
                       coalesce((select sum(days_count) from leave_requests l where l.user_id = u.id and l.leave_type = lt.key and l.status = 'approved' and extract(year from l.start_date) = p_year), 0) as used,
                       coalesce((select sum(days_count) from leave_requests l where l.user_id = u.id and l.leave_type = lt.key and l.status = 'pending' and extract(year from l.start_date) = p_year), 0) as pending
            ) e
            where lt.organization_id = p_org and lt.is_active), '[]'::jsonb)) as row
        from users u
        where u.organization_id = p_org and u.is_active and not u.is_owner and (p_after is null or u.id > p_after)
        order by u.id limit least(greatest(coalesce(p_limit, 100), 1), 200)
    ) x;
$$;

-- Write: attendance events -------------------------------------------------------------------
create table if not exists public.api_attendance_imports (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    api_key_id uuid references public.api_keys(id) on delete set null,
    external_id text not null check (length(external_id) between 1 and 120),
    employee_id uuid not null references public.users(id) on delete cascade,
    site_id uuid references public.sites(id) on delete set null,
    event_type text not null check (event_type in ('clock_in', 'clock_out')),
    occurred_at timestamptz not null,
    device text check (device is null or length(device) <= 120),
    status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
    status_reason text,
    attendance_session_id uuid references public.attendance_sessions(id) on delete set null,
    reviewed_by uuid references public.users(id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (organization_id, external_id)
);
create index if not exists api_attendance_imports_pending_idx on public.api_attendance_imports (organization_id, employee_id, occurred_at) where status = 'pending';
alter table public.api_attendance_imports enable row level security;
revoke all on public.api_attendance_imports from anon, authenticated;

create or replace function public.api_v1_attendance_import(p_org uuid, p_key uuid, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_event jsonb;
    v_ext text;
    v_emp uuid;
    v_site uuid;
    v_type text;
    v_at timestamptz;
    v_existing api_attendance_imports%rowtype;
    v_results jsonb := '[]'::jsonb;
    v_reason text;
begin
    if jsonb_typeof(p_events) <> 'array' then raise exception 'EVENTS MUST BE AN ARRAY'; end if;
    if jsonb_array_length(p_events) = 0 or jsonb_array_length(p_events) > 500 then raise exception 'SEND 1 TO 500 EVENTS AT A TIME'; end if;
    for v_event in select * from jsonb_array_elements(p_events) loop
        v_reason := null;
        v_ext := nullif(trim(coalesce(v_event ->> 'externalId', '')), '');
        v_type := v_event ->> 'type';
        begin
            v_emp := (v_event ->> 'employeeId')::uuid;
            v_site := nullif(v_event ->> 'siteId', '')::uuid;
            v_at := (v_event ->> 'occurredAt')::timestamptz;
        exception when others then
            v_reason := 'invalid_value';
        end;
        if v_reason is null then
            v_reason := case
                when v_ext is null or length(v_ext) > 120 then 'external_id_required'
                when v_type not in ('clock_in', 'clock_out') or v_type is null then 'invalid_type'
                when v_at is null then 'occurred_at_required'
                when v_at > now() + interval '5 minutes' then 'in_the_future'
                when v_at < now() - interval '62 days' then 'too_old'
                when v_emp is null or not exists (select 1 from users where id = v_emp and organization_id = p_org and is_active) then 'unknown_employee'
                when v_site is not null and not exists (select 1 from sites where id = v_site and organization_id = p_org) then 'unknown_site'
            end;
        end if;
        if v_reason is not null then
            v_results := v_results || jsonb_build_object('externalId', v_ext, 'status', 'rejected', 'reason', v_reason);
            continue;
        end if;
        select * into v_existing from api_attendance_imports where organization_id = p_org and external_id = v_ext;
        if v_existing.id is not null then
            if v_existing.employee_id = v_emp and v_existing.event_type = v_type and v_existing.occurred_at = v_at then
                v_results := v_results || jsonb_build_object('externalId', v_ext, 'status', 'duplicate', 'id', v_existing.id);
            else
                v_results := v_results || jsonb_build_object('externalId', v_ext, 'status', 'conflict', 'reason', 'external_id_reused_with_other_content');
            end if;
            continue;
        end if;
        insert into api_attendance_imports (organization_id, api_key_id, external_id, employee_id, site_id, event_type, occurred_at, device)
        values (p_org, p_key, v_ext, v_emp, v_site, v_type, v_at, left(v_event ->> 'device', 120))
        returning * into v_existing;
        v_results := v_results || jsonb_build_object('externalId', v_ext, 'status', 'accepted', 'id', v_existing.id);
    end loop;
    return jsonb_build_object(
        'accepted', (select count(*) from jsonb_array_elements(v_results) r where r ->> 'status' = 'accepted'),
        'duplicates', (select count(*) from jsonb_array_elements(v_results) r where r ->> 'status' = 'duplicate'),
        'rejected', (select count(*) from jsonb_array_elements(v_results) r where r ->> 'status' in ('rejected', 'conflict')),
        'results', v_results);
end;
$$;

do $$
declare
    v_fn text;
begin
    foreach v_fn in array array['public.api_v1_shifts(uuid, date, date, uuid, integer)', 'public.api_v1_leave_balances(uuid, integer, uuid, integer)',
        'public.api_v1_attendance_import(uuid, uuid, jsonb)'] loop
        execute format('revoke all on function %s from public, anon, authenticated', v_fn);
        execute format('grant execute on function %s to service_role', v_fn);
    end loop;
end $$;

-- Review in the app ---------------------------------------------------------------------------
-- Who may: the owner, or whoever may correct attendance for that person.
create or replace function public.prosm_time_may_review_import(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.current_prosm_time_user_is_owner()
        or (public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), 'attendance.correct')
            and public.prosm_time_caller_has_authority_over(p_employee));
$$;
revoke all on function public.prosm_time_may_review_import(uuid) from public, anon, authenticated;

create or replace function public.list_prosm_time_imported_attendance(p_status text default 'pending')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'externalId', i.external_id, 'employeeId', i.employee_id, 'employeeName', u.full_name, 'siteId', i.site_id, 'siteName', s.name,
        'type', i.event_type, 'occurredAt', i.occurred_at, 'device', i.device, 'status', i.status, 'reason', i.status_reason,
        'source', (select k.name from api_keys k where k.id = i.api_key_id), 'createdAt', i.created_at)
        order by u.full_name, i.occurred_at), '[]'::jsonb)
    from api_attendance_imports i join users u on u.id = i.employee_id left join sites s on s.id = i.site_id
    where i.organization_id = public.current_prosm_time_organization_id() and i.status = coalesce(p_status, 'pending')
      and public.prosm_time_may_review_import(i.employee_id);
$$;
revoke all on function public.list_prosm_time_imported_attendance(text) from public, anon;
grant execute on function public.list_prosm_time_imported_attendance(text) to authenticated;

-- Approve: each clock-in with the next clock-out of the same person becomes one attendance record.
create or replace function public.approve_prosm_time_imported_attendance(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_me uuid := public.current_prosm_time_user_id();
    v_in api_attendance_imports%rowtype;
    v_out api_attendance_imports%rowtype;
    v_session uuid;
    v_applied integer := 0;
    v_left integer := 0;
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if coalesce(cardinality(p_ids), 0) = 0 then raise exception 'CHOOSE AT LEAST ONE EVENT'; end if;
    if exists (select 1 from api_attendance_imports where id = any(p_ids) and (organization_id <> v_org or not public.prosm_time_may_review_import(employee_id))) then
        raise exception 'ATTENDANCE.CORRECT AUTHORITY REQUIRED';
    end if;
    for v_in in
        select * from api_attendance_imports where id = any(p_ids) and status = 'pending' and event_type = 'clock_in' order by employee_id, occurred_at for update
    loop
        select * into v_out from api_attendance_imports
        where organization_id = v_org and employee_id = v_in.employee_id and status = 'pending' and event_type = 'clock_out'
          and id = any(p_ids) and occurred_at > v_in.occurred_at
          and not exists (select 1 from api_attendance_imports x where x.employee_id = v_in.employee_id and x.status = 'pending' and x.event_type = 'clock_in'
                          and x.occurred_at > v_in.occurred_at and x.occurred_at < api_attendance_imports.occurred_at)
        order by occurred_at limit 1 for update;
        if v_out.id is null then
            update api_attendance_imports set status_reason = 'no_matching_clock_out' where id = v_in.id;
            continue;
        end if;
        if v_out.occurred_at - v_in.occurred_at > interval '24 hours' then
            update api_attendance_imports set status_reason = 'longer_than_24_hours' where id in (v_in.id, v_out.id);
            continue;
        end if;
        if exists (select 1 from attendance_sessions s where s.user_id = v_in.employee_id
                   and tstzrange(s.clock_in_at, coalesce(s.clock_out_at, now())) && tstzrange(v_in.occurred_at, v_out.occurred_at)) then
            update api_attendance_imports set status_reason = 'overlaps_existing_attendance' where id in (v_in.id, v_out.id);
            continue;
        end if;
        insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
        values (v_org, v_in.employee_id, coalesce(v_in.site_id, v_out.site_id), 'clocked_out', v_in.occurred_at, v_out.occurred_at)
        returning id into v_session;
        insert into attendance_events (session_id, user_id, event_type, occurred_at, idempotency_key, geofence_checked, within_geofence, note, time_source)
        values (v_session, v_in.employee_id, 'clock_in', v_in.occurred_at, 'import:' || v_in.id, false, null, 'imported: ' || v_in.external_id, 'imported'),
               (v_session, v_in.employee_id, 'clock_out', v_out.occurred_at, 'import:' || v_out.id, false, null, 'imported: ' || v_out.external_id, 'imported');
        update api_attendance_imports set status = 'applied', status_reason = null, attendance_session_id = v_session, reviewed_by = v_me, reviewed_at = now()
        where id in (v_in.id, v_out.id);
        insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, context)
        values (v_org, v_me, v_in.employee_id, 'attendance.import_approved', 'attendance_sessions', v_session,
                'Approved attendance received through the API',
                jsonb_build_object('clockIn', v_in.occurred_at, 'clockOut', v_out.occurred_at, 'externalIds', jsonb_build_array(v_in.external_id, v_out.external_id)));
        v_applied := v_applied + 1;
    end loop;
    select count(*) into v_left from api_attendance_imports where id = any(p_ids) and status = 'pending';
    return jsonb_build_object('success', true, 'applied', v_applied, 'stillPending', v_left);
end;
$$;
revoke all on function public.approve_prosm_time_imported_attendance(uuid[]) from public, anon;
grant execute on function public.approve_prosm_time_imported_attendance(uuid[]) to authenticated;

create or replace function public.reject_prosm_time_imported_attendance(p_ids uuid[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid := public.current_prosm_time_organization_id();
    v_count integer;
begin
    if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'A REASON IS REQUIRED'; end if;
    if exists (select 1 from api_attendance_imports where id = any(p_ids) and (organization_id <> v_org or not public.prosm_time_may_review_import(employee_id))) then
        raise exception 'ATTENDANCE.CORRECT AUTHORITY REQUIRED';
    end if;
    update api_attendance_imports set status = 'rejected', status_reason = trim(p_reason), reviewed_by = public.current_prosm_time_user_id(), reviewed_at = now()
    where id = any(p_ids) and status = 'pending';
    get diagnostics v_count = row_count;
    insert into audit_logs (organization_id, actor_user_id, action, entity_name, description, reason, context)
    values (v_org, public.current_prosm_time_user_id(), 'attendance.import_rejected', 'api_attendance_imports', 'Rejected attendance received through the API',
            trim(p_reason), jsonb_build_object('count', v_count));
    return jsonb_build_object('success', true, 'rejected', v_count);
end;
$$;
revoke all on function public.reject_prosm_time_imported_attendance(uuid[], text) from public, anon;
grant execute on function public.reject_prosm_time_imported_attendance(uuid[], text) to authenticated;

commit;
