-- Governance phase B (owner 2026-11-15, docs/governance/PROJECT_AWARE_GOVERNANCE_ASSESSMENT.md sections 14.2, 14.5).
--
-- 1. Attendance is evidence: every change to a recorded time - a shift's start or end, a clock event's time - is
--    written automatically, by a trigger, to attendance_revisions with its previous and new value, on every path
--    (correction approval, a manager's review of an automatic close, a direct write, any future function). The
--    tables keep holding the effective time the screens and the payroll already read, so nothing they show
--    changes; what changes is that the original is never lost again. attendance_revisions is append-only (the
--    phase A guard). Closing an open shift (no end yet -> an end) is a first value, not a revision.
--    History: corrections approved before this migration overwrote the time. Their originals are not invented:
--    each approved correction gets one row with evidence_source = 'none' and previous_value null ("corrected
--    before the revision log; the original is not kept"), unless an audit row carries the earlier time
--    explicitly - none of the old correction paths wrote one, so in practice all are 'none'.
--
-- 2. Pay-period lock: a recorded time inside an approved/locked payroll cycle or an approved timesheet of that
--    person is not changed, deleted or back-filled by someone else until the cycle is reopened / the timesheet
--    returned. Enforced by triggers on the tables themselves (every path). Concurrency: the check takes FOR SHARE
--    on the cycle / timesheet rows; approving a cycle takes FOR UPDATE on its row (transition_...) and approving
--    a timesheet updates its row, so the two always serialise - whoever comes second sees the other's committed
--    result (READ COMMITTED re-reads the locked row).
--    Not locked (so no punch is ever lost): a person's own punches, live or synced from offline; closing an open
--    shift (the automatic close included); deletes cascading from a removed person or organisation.
--    The legal data deletion keeps its retention hold and now also stops at a locked pay period.
--
-- 3. Payroll: submitting a cycle with leave or correction requests still pending inside its period needs the
--    warnings acknowledged (D7) - the acknowledgement is recorded on the cycle as before.
-- Rollback: drop the triggers attendance_*_revision, *_period_lock and their functions, drop table
-- attendance_revisions, re-run validate_prosm_time_payroll_cycle from 20261108130000.

begin;

-- 1. The revision log ---------------------------------------------------------------------------
create table if not exists public.attendance_revisions (
    id bigint generated always as identity primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    session_id uuid not null references public.attendance_sessions(id) on delete cascade,
    event_id uuid references public.attendance_events(id) on delete cascade,
    field text not null check (field in ('clock_in_at', 'clock_out_at', 'occurred_at')),
    previous_value timestamptz,
    new_value timestamptz,
    revised_by uuid references public.users(id) on delete set null,
    correction_request_id uuid references public.correction_requests(id) on delete set null,
    evidence_source text not null check (evidence_source in ('live', 'audit_log', 'none')),
    evidence_ref uuid,
    created_at timestamptz not null default now(),
    check (evidence_source <> 'live' or previous_value is not null)
);
create index if not exists attendance_revisions_session_idx on public.attendance_revisions (session_id, created_at);
create index if not exists attendance_revisions_org_idx on public.attendance_revisions (organization_id, created_at desc);
create unique index if not exists attendance_revisions_history_once on public.attendance_revisions (correction_request_id, field)
    where evidence_source <> 'live';
alter table public.attendance_revisions enable row level security;
-- no policies: read through get_prosm_time_attendance_revisions below
revoke all on public.attendance_revisions from anon, authenticated;
revoke update, delete, truncate on public.attendance_revisions from service_role;
drop trigger if exists attendance_revisions_append_only on public.attendance_revisions;
create trigger attendance_revisions_append_only before update or delete on public.attendance_revisions
    for each row execute function public.prosm_time_append_only_guard();
drop trigger if exists attendance_revisions_no_truncate on public.attendance_revisions;
create trigger attendance_revisions_no_truncate before truncate on public.attendance_revisions
    for each statement execute function public.prosm_time_append_only_guard();

-- the approved correction that produced this value, if any (data, not a session flag)
create or replace function public.prosm_time_correction_for(p_session_id uuid, p_value timestamptz)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select id from correction_requests
    where attendance_session_id = p_session_id and status = 'approved' and proposed_correct_time = p_value
    order by created_at desc limit 1;
$$;
revoke all on function public.prosm_time_correction_for(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.prosm_time_record_session_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.clock_in_at is not null and new.clock_in_at is distinct from old.clock_in_at then
        insert into attendance_revisions (organization_id, user_id, session_id, field, previous_value, new_value, revised_by, correction_request_id, evidence_source)
        values (new.organization_id, new.user_id, new.id, 'clock_in_at', old.clock_in_at, new.clock_in_at,
                public.current_prosm_time_user_id(), public.prosm_time_correction_for(new.id, new.clock_in_at), 'live');
    end if;
    if old.clock_out_at is not null and new.clock_out_at is distinct from old.clock_out_at then
        insert into attendance_revisions (organization_id, user_id, session_id, field, previous_value, new_value, revised_by, correction_request_id, evidence_source)
        values (new.organization_id, new.user_id, new.id, 'clock_out_at', old.clock_out_at, new.clock_out_at,
                public.current_prosm_time_user_id(), public.prosm_time_correction_for(new.id, new.clock_out_at), 'live');
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_record_session_revision() from public, anon, authenticated;

drop trigger if exists attendance_sessions_revision on public.attendance_sessions;
create trigger attendance_sessions_revision after update of clock_in_at, clock_out_at on public.attendance_sessions
    for each row execute function public.prosm_time_record_session_revision();

create or replace function public.prosm_time_record_event_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.occurred_at is distinct from old.occurred_at then
        insert into attendance_revisions (organization_id, user_id, session_id, event_id, field, previous_value, new_value, revised_by, correction_request_id, evidence_source)
        select s.organization_id, new.user_id, new.session_id, new.id, 'occurred_at', old.occurred_at, new.occurred_at,
               public.current_prosm_time_user_id(), public.prosm_time_correction_for(new.session_id, new.occurred_at), 'live'
        from attendance_sessions s where s.id = new.session_id;
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_record_event_revision() from public, anon, authenticated;

drop trigger if exists attendance_events_revision on public.attendance_events;
create trigger attendance_events_revision after update of occurred_at on public.attendance_events
    for each row execute function public.prosm_time_record_event_revision();

-- History: corrections approved before today. Nothing is invented: no earlier value without evidence.
insert into attendance_revisions (organization_id, user_id, session_id, field, previous_value, new_value, correction_request_id, evidence_source, created_at)
select cr.organization_id, cr.user_id, cr.attendance_session_id,
       case when cr.proposed_event_type = 'clock_in' then 'clock_in_at' else 'clock_out_at' end,
       null, cr.proposed_correct_time, cr.id, 'none', cr.created_at
from correction_requests cr
join attendance_sessions s on s.id = cr.attendance_session_id
where cr.status = 'approved' and cr.proposed_correct_time is not null and cr.proposed_event_type in ('clock_in', 'clock_out')
on conflict do nothing;

-- Reading: whoever may see this person's attendance (the person, their managers, the owner)
create or replace function public.get_prosm_time_attendance_revisions(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_session attendance_sessions%rowtype;
    v_me uuid := public.current_prosm_time_user_id();
begin
    if v_me is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    select * into v_session from attendance_sessions where id = p_session_id and organization_id = public.current_prosm_time_organization_id();
    if v_session.id is null then raise exception 'ATTENDANCE SESSION NOT FOUND'; end if;
    if v_session.user_id <> v_me and not public.prosm_time_caller_has_authority_over(v_session.user_id, coalesce(v_session.site_id, v_session.responsible_site_id)) then
        raise exception 'ATTENDANCE SESSION NOT FOUND';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object('field', r.field, 'previous', r.previous_value, 'new', r.new_value,
                                            'evidence', r.evidence_source, 'correctionRequestId', r.correction_request_id,
                                            'revisedBy', u.full_name, 'at', r.created_at) order by r.created_at, r.id)
        from attendance_revisions r left join users u on u.id = r.revised_by
        where r.session_id = p_session_id
    ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_prosm_time_attendance_revisions(uuid) from public, anon;
grant execute on function public.get_prosm_time_attendance_revisions(uuid) to authenticated;

-- 2. The pay-period lock ------------------------------------------------------------------------
-- true when a day of [p_from, p_to] (organisation dates) is inside an approved/locked payroll cycle that
-- includes the person, or an approved timesheet of the person. Takes FOR SHARE on what it reads.
create or replace function public.prosm_time_pay_period_locked(p_user_id uuid, p_from date, p_to date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_status text;
begin
    for v_status in
        select c.status from payroll_cycles c join payroll_cycle_employees ce on ce.cycle_id = c.id
        where ce.user_id = p_user_id and c.period_start <= p_to and c.period_end >= p_from
        for share of c
    loop
        if v_status in ('approved', 'locked') then return true; end if;
    end loop;
    for v_status in
        select t.status from timesheets t
        where t.user_id = p_user_id and t.period_start <= p_to and t.period_end >= p_from
        for share of t
    loop
        if v_status = 'approved' then return true; end if;
    end loop;
    return false;
end;
$$;
revoke all on function public.prosm_time_pay_period_locked(uuid, date, date) from public, anon, authenticated;

create or replace function public.prosm_time_org_day(p_org uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = public
as $$
    select (p_at at time zone public.prosm_time_tz_or((select timezone from organization_settings where organization_id = p_org), 'Africa/Cairo'))::date;
$$;
revoke all on function public.prosm_time_org_day(uuid, timestamptz) from public, anon, authenticated;

-- raises when one of the given times of this person falls in a locked pay period
create or replace function public.prosm_time_assert_pay_period_open(p_org uuid, p_user_id uuid, p_times timestamptz[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_at timestamptz;
    v_day date;
begin
    foreach v_at in array p_times loop
        continue when v_at is null;
        v_day := public.prosm_time_org_day(p_org, v_at);
        if public.prosm_time_pay_period_locked(p_user_id, v_day, v_day) then
            raise exception 'THIS PAY PERIOD IS LOCKED - REOPEN THE PAYROLL OR RETURN THE TIMESHEET FIRST';
        end if;
    end loop;
end;
$$;
revoke all on function public.prosm_time_assert_pay_period_open(uuid, uuid, timestamptz[]) from public, anon, authenticated;

-- a signed-in person writing about someone else (a manager, on someone's behalf); not the person, not the system
create or replace function public.prosm_time_writer_is_other_than(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(auth.role(), '') = 'authenticated'
       and auth.uid() is distinct from (select auth_user_id from users where id = p_user_id);
$$;
revoke all on function public.prosm_time_writer_is_other_than(uuid) from public, anon, authenticated;

create or replace function public.prosm_time_session_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'DELETE' then
        -- a cascade from a removed person or organisation is not an edit of the period
        if not exists (select 1 from users where id = old.user_id) or not exists (select 1 from organizations where id = old.organization_id) then
            return old;
        end if;
        perform public.prosm_time_assert_pay_period_open(old.organization_id, old.user_id, array[old.clock_in_at, old.clock_out_at]);
        return old;
    end if;
    if tg_op = 'INSERT' then
        if public.prosm_time_writer_is_other_than(new.user_id) then
            perform public.prosm_time_assert_pay_period_open(new.organization_id, new.user_id, array[new.clock_in_at, new.clock_out_at]);
        end if;
        return new;
    end if;
    -- UPDATE: changing a recorded time (closing an open shift is a first value, not a change)
    if old.clock_in_at is not null and new.clock_in_at is distinct from old.clock_in_at then
        perform public.prosm_time_assert_pay_period_open(new.organization_id, new.user_id, array[old.clock_in_at, new.clock_in_at]);
    end if;
    if old.clock_out_at is not null and new.clock_out_at is distinct from old.clock_out_at then
        perform public.prosm_time_assert_pay_period_open(new.organization_id, new.user_id, array[old.clock_out_at, new.clock_out_at]);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_session_period_lock() from public, anon, authenticated;

drop trigger if exists attendance_sessions_period_lock on public.attendance_sessions;
create trigger attendance_sessions_period_lock before insert or update of clock_in_at, clock_out_at or delete on public.attendance_sessions
    for each row execute function public.prosm_time_session_period_lock();

create or replace function public.prosm_time_event_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
begin
    select organization_id into v_org from attendance_sessions where id = coalesce(new.session_id, old.session_id);
    if tg_op = 'DELETE' then
        if v_org is null or not exists (select 1 from users where id = old.user_id) then return old; end if;
        perform public.prosm_time_assert_pay_period_open(v_org, old.user_id, array[old.occurred_at]);
        return old;
    end if;
    if tg_op = 'INSERT' then
        if v_org is not null and public.prosm_time_writer_is_other_than(new.user_id) then
            perform public.prosm_time_assert_pay_period_open(v_org, new.user_id, array[new.occurred_at]);
        end if;
        return new;
    end if;
    if new.occurred_at is distinct from old.occurred_at then
        perform public.prosm_time_assert_pay_period_open(v_org, new.user_id, array[old.occurred_at, new.occurred_at]);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_event_period_lock() from public, anon, authenticated;

drop trigger if exists attendance_events_period_lock on public.attendance_events;
create trigger attendance_events_period_lock before insert or update of occurred_at or delete on public.attendance_events
    for each row execute function public.prosm_time_event_period_lock();

create or replace function public.prosm_time_break_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'DELETE' then
        if not exists (select 1 from users where id = old.user_id) or not exists (select 1 from organizations where id = old.organization_id) then
            return old;
        end if;
        perform public.prosm_time_assert_pay_period_open(old.organization_id, old.user_id, array[old.started_at, old.ended_at]);
        return old;
    end if;
    if new.started_at is distinct from old.started_at then
        perform public.prosm_time_assert_pay_period_open(new.organization_id, new.user_id, array[old.started_at, new.started_at]);
    end if;
    if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
        perform public.prosm_time_assert_pay_period_open(new.organization_id, new.user_id, array[old.ended_at, new.ended_at]);
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_break_period_lock() from public, anon, authenticated;

drop trigger if exists break_events_period_lock on public.break_events;
create trigger break_events_period_lock before update of started_at, ended_at or delete on public.break_events
    for each row execute function public.prosm_time_break_period_lock();

-- an approved leave inside a locked period is neither granted nor withdrawn until the period reopens
create or replace function public.prosm_time_leave_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status is distinct from old.status and (old.status = 'approved' or new.status = 'approved')
       and public.prosm_time_pay_period_locked(new.user_id, new.start_date, new.end_date) then
        raise exception 'THIS PAY PERIOD IS LOCKED - REOPEN THE PAYROLL OR RETURN THE TIMESHEET FIRST';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_leave_period_lock() from public, anon, authenticated;

drop trigger if exists leave_requests_period_lock on public.leave_requests;
create trigger leave_requests_period_lock before update of status on public.leave_requests
    for each row execute function public.prosm_time_leave_period_lock();

-- 3. Payroll: pending requests inside the period are a warning to acknowledge (D7) ------------
do $$
declare
    v_def text;
    v_anchor text := E'    return jsonb_build_object(''errors'', v_errors, ''warnings'', v_warnings, ''canSubmit''';
    v_add text := E'    -- governance phase B (D7): requests still pending inside the period\n'
        || E'    select v_warnings || coalesce(jsonb_agg(jsonb_build_object(''code'', ''PENDING_REQUESTS'', ''userId'', p.user_id, ''fullName'', p.full_name, ''count'', p.n)), ''[]''::jsonb)\n'
        || E'    into v_warnings\n'
        || E'    from (\n'
        || E'        select ce.user_id, ce.full_name, count(*) as n\n'
        || E'        from payroll_cycle_employees ce\n'
        || E'        join lateral (\n'
        || E'            select 1 from leave_requests lr where lr.user_id = ce.user_id and lr.status = ''pending''\n'
        || E'               and lr.start_date <= v_cycle.period_end and lr.end_date >= v_cycle.period_start\n'
        || E'            union all\n'
        || E'            select 1 from correction_requests cr join attendance_sessions s on s.id = cr.attendance_session_id\n'
        || E'            where cr.user_id = ce.user_id and cr.status = ''pending''\n'
        || E'              and public.prosm_time_org_day(s.organization_id, s.clock_in_at) between v_cycle.period_start and v_cycle.period_end\n'
        || E'        ) r on true\n'
        || E'        where ce.cycle_id = p_cycle_id\n'
        || E'        group by ce.user_id, ce.full_name\n'
        || E'    ) p;\n\n';
begin
    v_def := replace(pg_get_functiondef('public.validate_prosm_time_payroll_cycle(uuid)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('PENDING_REQUESTS' in v_def) > 0 then return; end if;
    if position(v_anchor in v_def) = 0 then raise exception 'validate payroll cycle: anchor not found'; end if;
    execute replace(v_def, v_anchor, v_add || v_anchor);
end $$;

commit;
