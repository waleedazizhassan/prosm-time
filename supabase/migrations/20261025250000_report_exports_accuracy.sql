-- v2.3.43 step 18 (item 16): the exported reports reflect what the earlier
-- steps added.
--   * Missing check-outs: each long session says whether it is still open,
--     closed automatically and waiting for the manager's review (step 2,
--     not counted until reviewed), reviewed, or closed normally; the day is
--     the site's own day (step 3).
--   * Absences: only on a working day - a public holiday or a weekly rest
--     day (step 3 calendar) is not an absence; the day of a clock-in is the
--     site's own day, not UTC.
--   * Manager actions: besides clocking in/out on behalf, every privileged
--     change - overriding a block (step 1), reviewing pending hours and
--     extending a session (step 2), editing an allowance under review or
--     reopening an approved sheet (step 5), approving overtime, adjusting a
--     day or granting a permission (step 6), cancelling approved leave
--     (step 8) and setting or changing a leave deduction (step 9). Those
--     are shown for the people the reader can see.

begin;

-- the result gains a column, so the function is replaced, not altered
drop function if exists public.list_prosm_time_report_missing_checkouts(date, date);

create function public.list_prosm_time_report_missing_checkouts(p_start_date date, p_end_date date)
returns table(session_id uuid, user_full_name text, site_name text, clock_in_at timestamptz, hours_open numeric, still_open boolean, review_state text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        sess.id, u.full_name, coalesce(s.name, sess.manual_location_label, '-'),
        sess.clock_in_at,
        round((extract(epoch from (coalesce(sess.clock_out_at, now()) - sess.clock_in_at)) / 3600.0)::numeric, 1),
        sess.status = 'clocked_in',
        case
            when sess.status = 'clocked_in' then 'open'
            when sess.hours_review_status = 'pending' then 'pending_review'
            when sess.hours_review_status = 'reviewed' then 'reviewed'
            when sess.auto_closed then 'auto_closed'
            else 'closed'
        end
    from attendance_sessions sess
    join users u on u.id = sess.user_id
    left join sites s on s.id = sess.site_id
    where sess.organization_id = v_org
      and public.prosm_time_work_date(sess.clock_in_at, sess.site_id, v_org) between p_start_date and p_end_date
      and coalesce(sess.clock_out_at, now()) - sess.clock_in_at > interval '12 hours'
      and (
          public.current_prosm_time_user_is_owner()
          -- A no-site (GPS-only) session has nothing to scope against -
          -- same posture as admin_clock_out_prosm_time_attendance
          -- (Owner-only for those); excluded from a Manager's report.
          or sess.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by sess.clock_in_at desc;
end;
$function$;

revoke all on function public.list_prosm_time_report_missing_checkouts(date, date) from public, anon;
grant execute on function public.list_prosm_time_report_missing_checkouts(date, date) to authenticated;

create or replace function public.list_prosm_time_report_absences(p_start_date date, p_end_date date)
returns table(shift_assignment_id uuid, user_full_name text, site_name text, shift_date date, shift_start_time time without time zone, shift_end_time time without time zone)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        sa.id, u.full_name, s.name,
        sa.shift_date, sa.start_time, sa.end_time
    from shift_assignments sa
    join users u on u.id = sa.user_id
    join sites s on s.id = sa.site_id
    where sa.organization_id = v_org
      and sa.status = 'scheduled'
      and sa.shift_date between p_start_date and p_end_date
      -- step 18: a public holiday or a weekly rest day is not an absence
      and public.prosm_time_day_type(sa.user_id, sa.site_id, sa.shift_date) = 'workday'
      -- A real absence: no attendance session at all for this user on
      -- this shift date (any site - a real clock-in anywhere on the
      -- right day is not an absence), the day counted at the site.
      and not exists (
          select 1 from attendance_sessions ats
          where ats.user_id = sa.user_id
          and public.prosm_time_work_date(ats.clock_in_at, coalesce(ats.site_id, sa.site_id), v_org) = sa.shift_date
      )
      -- Not an absence if covered by approved leave that day.
      and not exists (
          select 1 from leave_requests lr
          where lr.user_id = sa.user_id
          and lr.status = 'approved'
          and sa.shift_date between lr.start_date and lr.end_date
      )
      and (
          public.current_prosm_time_user_is_owner()
          or sa.site_id = any(public.current_prosm_time_managed_site_ids())
      )
    order by sa.shift_date, u.full_name;
exception
    when others then
        raise exception 'LIST PROSM TIME REPORT ABSENCES FAILED: %', sqlerrm;
end;
$function$;

create or replace function public.list_prosm_time_report_manager_overrides(p_start_date date, p_end_date date)
returns table(audit_log_id uuid, actor_name text, subject_name text, action text, description text, reason text, created_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    if v_caller_id is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not public.current_prosm_time_user_is_owner()
       and not ('attendance.view' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))) then
        raise exception 'ATTENDANCE.VIEW AUTHORITY REQUIRED';
    end if;
    v_org := public.current_prosm_time_organization_id();
    if p_start_date is null or p_end_date is null then
        raise exception 'START AND END DATE ARE REQUIRED';
    end if;

    return query
    select
        al.id, coalesce(actor.full_name, '-'), coalesce(subject.full_name, '-'),
        al.action, al.description, al.reason, al.created_at
    from audit_logs al
    left join users actor on actor.id = al.actor_user_id
    left join users subject on subject.id = al.subject_user_id
    left join admin_on_behalf_actions aoba on aoba.audit_log_id = al.id
    left join attendance_sessions sess on sess.id = aoba.session_id
    left join site_worker_attendance swa on al.action = 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF' and swa.id = al.entity_id
    where al.organization_id = v_org
      and al.created_at::date between p_start_date and p_end_date
      and (
          (
              al.action in ('ADMIN_CLOCK_IN_ON_BEHALF', 'ADMIN_CLOCK_OUT_ON_BEHALF', 'ADMIN_CLOCK_OUT_SITE_WORKER_ON_BEHALF')
              and (
                  public.current_prosm_time_user_is_owner()
                  or sess.site_id = any(public.current_prosm_time_managed_site_ids())
                  or swa.site_id = any(public.current_prosm_time_managed_site_ids())
              )
          )
          or (
              al.action in (
                  'attendance.override_block', 'attendance.review_pending_hours', 'attendance.extend_session',
                  'allowances.edit_during_review', 'allowances.reopen_approved',
                  'attendance.overtime_approved', 'attendance.day_adjusted', 'attendance.permission_granted',
                  'leave.approved_cancelled', 'leave.deduction_set', 'leave.deduction_changed'
              )
              and (
                  public.current_prosm_time_user_is_owner()
                  or (al.subject_user_id is not null and public.prosm_time_caller_sees_person(al.subject_user_id))
              )
          )
      )
    order by al.created_at desc;
end;
$function$;

commit;
