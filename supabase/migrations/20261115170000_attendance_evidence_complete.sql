-- Governance verification on a real PostgreSQL (owner 2026-11-15: "review every path that changes attendance and make
-- sure the revision log cannot be bypassed"; real two-connection concurrency). Found and closed:
--   1. Two managers deciding the same correction at the same moment both went through (the second overwrote the
--      first): the row was locked (phase D) but its status was not checked again. A correction is decided only while
--      pending or waiting for clarification.
--   2. service_role could TRUNCATE the attendance tables - TRUNCATE fires no row trigger, so it skipped the pay-period
--      lock and the revision log. Revoked, and a statement trigger refuses it for everyone.
--   3. Deleting an attendance record left no trace: a delete is now written to the audit trail (append-only) - the
--      record's id and day only, so a legal data deletion does not copy personal data into the trail. A delete that
--      cascades from a removed person or organisation is not logged here (the removal itself is).
--   4. A recorded break time that changed was not kept: break start/end changes go to attendance_revisions too.
--   5. A reject arriving a moment after another manager approved the same leave became a revoke: the screen now sends
--      the status it saw, and the decision is refused if the request moved on.
-- Rollback: drop the triggers *_no_truncate (attendance), *_delete_trail, break_events_revision and their functions;
-- grant truncate back to service_role; re-run review_prosm_time_exception from 20261115140000; restore the field check;
-- drop review_prosm_time_leave(uuid,text,text,numeric,text) and re-run it from 20261027120000 + 20261108110000 + 20261115140000.

begin;

-- 1. one decision per correction ------------------------------------------------------------------------------
do $$
declare
    v_def text;
    v_anchor text := E'from correction_requests where id = p_target_id and organization_id = v_caller_org for update;\n        if v_cr.id is null then raise exception ''CORRECTION REQUEST NOT FOUND''; end if;\n';
begin
    v_def := replace(pg_get_functiondef('public.review_prosm_time_exception(text, uuid, text, text)'::regprocedure), chr(13) || chr(10), chr(10));
    if position('THIS REQUEST WAS ALREADY DECIDED' in v_def) > 0 then return; end if;
    if position(v_anchor in v_def) = 0 then raise exception 'review exception: anchor not found'; end if;
    execute replace(v_def, v_anchor, v_anchor
        || E'        if v_cr.status not in (''pending'', ''clarification_requested'') then raise exception ''THIS REQUEST WAS ALREADY DECIDED''; end if;\n');
end $$;

-- 2. no TRUNCATE around the triggers ---------------------------------------------------------------------------
create or replace function public.prosm_time_attendance_no_truncate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    raise exception 'ATTENDANCE IS EVIDENCE - IT IS NOT TRUNCATED (%)', tg_table_name;
end;
$$;
revoke all on function public.prosm_time_attendance_no_truncate() from public, anon, authenticated;

do $$
declare
    v_table text;
begin
    foreach v_table in array array['attendance_sessions', 'attendance_events', 'break_events'] loop
        execute format('revoke truncate on public.%I from anon, authenticated, service_role', v_table);
        execute format('drop trigger if exists %I on public.%I', v_table || '_no_truncate', v_table);
        execute format('create trigger %I before truncate on public.%I for each statement execute function public.prosm_time_attendance_no_truncate()',
                       v_table || '_no_truncate', v_table);
    end loop;
end $$;

-- 3. a deleted attendance record leaves a trace ----------------------------------------------------------------
create or replace function public.prosm_time_attendance_delete_trail()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org uuid;
    v_at timestamptz;
begin
    -- a cascade from a removed person or organisation is logged by that removal, not here
    if not exists (select 1 from users where id = old.user_id) then return old; end if;
    if tg_table_name = 'attendance_sessions' then
        v_org := old.organization_id; v_at := old.clock_in_at;
    elsif tg_table_name = 'break_events' then
        v_org := old.organization_id; v_at := old.started_at;
    else
        select organization_id into v_org from attendance_sessions where id = old.session_id;
        if v_org is null then return old; end if; -- its session is being deleted in the same statement
        v_at := old.occurred_at;
    end if;
    if not exists (select 1 from organizations where id = v_org) then return old; end if;
    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description, previous_state)
    values (v_org, public.current_prosm_time_user_id(), old.user_id, 'ATTENDANCE_RECORD_DELETED', tg_table_name, old.id,
            'An attendance record was deleted',
            jsonb_build_object('day', public.prosm_time_org_day(v_org, v_at)));
    return old;
end;
$$;
revoke all on function public.prosm_time_attendance_delete_trail() from public, anon, authenticated;

do $$
declare
    v_table text;
begin
    foreach v_table in array array['attendance_sessions', 'attendance_events', 'break_events'] loop
        execute format('drop trigger if exists %I on public.%I', v_table || '_delete_trail', v_table);
        execute format('create trigger %I after delete on public.%I for each row execute function public.prosm_time_attendance_delete_trail()',
                       v_table || '_delete_trail', v_table);
    end loop;
end $$;

-- 4. a changed break time is kept --------------------------------------------------------------------------------
alter table public.attendance_revisions drop constraint if exists attendance_revisions_field_check;
alter table public.attendance_revisions add constraint attendance_revisions_field_check
    check (field in ('clock_in_at', 'clock_out_at', 'occurred_at', 'break_started_at', 'break_ended_at'));

create or replace function public.prosm_time_record_break_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.started_at is not null and new.started_at is distinct from old.started_at then
        insert into attendance_revisions (organization_id, user_id, session_id, field, previous_value, new_value, revised_by, evidence_source)
        values (new.organization_id, new.user_id, new.attendance_session_id, 'break_started_at', old.started_at, new.started_at, public.current_prosm_time_user_id(), 'live');
    end if;
    if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
        insert into attendance_revisions (organization_id, user_id, session_id, field, previous_value, new_value, revised_by, evidence_source)
        values (new.organization_id, new.user_id, new.attendance_session_id, 'break_ended_at', old.ended_at, new.ended_at, public.current_prosm_time_user_id(), 'live');
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_record_break_revision() from public, anon, authenticated;

drop trigger if exists break_events_revision on public.break_events;
create trigger break_events_revision after update of started_at, ended_at on public.break_events
    for each row execute function public.prosm_time_record_break_revision();

-- 5. a leave decision is made on the state the manager saw ----------------------------------------------------------
-- The same RPC both decides a pending leave and revokes an approved one. Two managers on the same pending request at
-- the same moment: one approves, the other rejects a split second later - the lock (phase D) made them wait in turn,
-- but the reject then landed on an approved leave and silently became a revoke. The screen now says what it saw
-- (p_expected_status: 'pending' from the review screen, 'approved' from the revoke screen) and the decision is refused
-- if the request moved on. Left out (older app versions, grant-on-behalf), the behaviour is unchanged.
do $$
declare
    v_def text;
    v_head_old text := 'p_deduction_per_day numeric DEFAULT NULL::numeric)';
    v_anchor text := E'from leave_requests where id = p_request_id and organization_id = v_org for update;\n';
begin
    if to_regprocedure('public.review_prosm_time_leave(uuid, text, text, numeric, text)') is not null then return; end if;
    v_def := replace(pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text, numeric)'::regprocedure), chr(13) || chr(10), chr(10));
    if position(v_head_old in v_def) = 0 then raise exception 'review leave: header not found'; end if;
    if position(v_anchor in v_def) = 0 then raise exception 'review leave: anchor not found'; end if;
    v_def := replace(v_def, v_head_old, 'p_deduction_per_day numeric DEFAULT NULL::numeric, p_expected_status text DEFAULT NULL::text)');
    v_def := replace(v_def, v_anchor, v_anchor
        || E'    if p_expected_status is not null and v_request.id is not null and v_request.status is distinct from p_expected_status then raise exception ''THIS REQUEST WAS ALREADY DECIDED''; end if;\n');
    drop function public.review_prosm_time_leave(uuid, text, text, numeric);
    execute v_def;
end $$;
revoke all on function public.review_prosm_time_leave(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.review_prosm_time_leave(uuid, text, text, numeric, text) to authenticated, service_role;

commit;
