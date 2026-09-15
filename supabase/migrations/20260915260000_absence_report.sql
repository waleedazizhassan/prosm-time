-- PROSM Time - user-reported real gap (#7, 2026-09-15): "مش شايف اي
-- حاجة في البرنامج بتتكلم عن الغياب" - the app had no Absence concept
-- anywhere. Real shift_assignments (20260908220000) already carry a
-- precise, per-user, per-day "expected to work" signal - an Absence is
-- defined here as a real scheduled shift with no matching attendance
-- session and no approved leave covering that day. This is honest,
-- not a guess: it only ever flags someone who was formally scheduled,
-- never inferring "should have worked" for someone with no schedule
-- assignment at all (this app has no other reliable source for that).
-- Same shape/auth posture as every other Reports Center generic type
-- (list_prosm_time_report_missing_checkouts's own site-scoping - a
-- Manager sees only their own managed sites' absences, Owner sees all).

begin;

create or replace function public.list_prosm_time_report_absences(p_start_date date, p_end_date date)
returns table (
    shift_assignment_id uuid,
    user_full_name text,
    site_name text,
    shift_date date,
    shift_start_time time,
    shift_end_time time
)
language plpgsql
security definer
set search_path = public
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
      -- A real absence: no attendance session at all for this user on
      -- this shift date (any site - a real clock-in anywhere on the
      -- right day is not an absence, even if the assigned site was
      -- different, matching how leaveConflicts/late already treat
      -- "was there real attendance activity" as the honest signal).
      and not exists (
          select 1 from attendance_sessions ats
          where ats.user_id = sa.user_id
          and ats.clock_in_at::date = sa.shift_date
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

grant execute on function public.list_prosm_time_report_absences(date, date) to authenticated;

commit;
