-- Owner 2026-11-11: "Friday is not a fixed rest day. It follows the site's or the shift's schedule of
-- work and rest days. If Friday is a work day for the employee, lateness counts normally; if it is their
-- rest day, no lateness. And an employee who did not clock in at all on their rest day or on a recorded
-- holiday is resting."
--
-- Rest days were already per person (the shift template's, else the site's, else the organisation's;
-- Friday is only the organisation's default). The gap: a shift actually scheduled for the person on a day
-- that is otherwise a weekly rest day still counted as rest (no lateness, the whole day overtime). Now a
-- scheduled shift makes that day a work day for that person. A recorded public holiday stays a holiday.
-- Absence was already right: no clock-in on a rest day or a recorded holiday is rest, not absence.
-- Not live until the owner approves (HR suite branch).
--
-- Rollback: restore prosm_time_day_type from 20261025120000_work_calendar.sql.

begin;

create or replace function public.prosm_time_day_type(p_user_id uuid, p_site_id uuid, p_date date)
returns text
language sql
stable
security definer
set search_path = public
as $function$
    select case
        when exists (
            select 1 from public_holidays h join users u on u.organization_id = h.organization_id
            where u.id = p_user_id and p_date between h.start_date and h.end_date
              and (h.site_id is null or h.site_id = p_site_id)
        ) then 'public_holiday'
        -- a shift scheduled for the person that day: it is their work day
        when exists (select 1 from shift_assignments sa where sa.user_id = p_user_id and sa.shift_date = p_date and sa.status = 'scheduled') then 'workday'
        when extract(dow from p_date)::smallint = any(public.prosm_time_rest_days(p_user_id, p_site_id, p_date)) then 'weekly_rest'
        else 'workday'
    end;
$function$;
revoke all on function public.prosm_time_day_type(uuid, uuid, date) from public, anon, authenticated;

commit;
