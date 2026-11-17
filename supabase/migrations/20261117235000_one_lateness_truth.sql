-- Owner 2026-11-17 (Ratomag): the "yesterday's summary" notification said 10 late, the daily summary page 8, for
-- the same day (16 Nov). Three rules were counting lateness:
--   * the notification (prosm_time_late_today): first clock-in after the start - ignoring an approved late-arrival
--     permission and the organisation's minimum late minutes;
--   * the page (get_prosm_time_daily_summary): its own sum, which found no start time for a person working
--     without a site (it did not use the site they are responsible for), so never counted them late;
--   * the pay calculation (prosm_time_day_summary): the start of the day (exceptional day > roster > the site, or
--     the responsible site's hours without a site), the minimum late minutes, approved permissions and the
--     manager's adjustment. This is what is deducted - the truth.
-- Now everything follows the pay calculation. While a person is still clocked in (their session does not count
-- yet, so the pay calculation has no lateness for it), a live check applies the same start, the same minimum and an
-- approved paid late-arrival permission, so today's cards show it at once.
-- Applies to: the morning summary notification, the daily summary page (count, list and minutes) and the manager
-- dashboard (it already used the pay calculation, OR this function for the live case).
-- Rollback: restore prosm_time_late_today and get_prosm_time_daily_summary from pg_get_functiondef before this.
begin;

create or replace function public.prosm_time_late_today(p_user uuid, p_day date)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_summary jsonb := public.prosm_time_day_summary(p_user, p_day);
    v_first record;
    v_start time;
    v_tz text;
    v_min numeric;
begin
    -- the pay calculation decides whenever it has the day's worked time
    if coalesce((v_summary ->> 'lateMinutes')::numeric, 0) > 0 then return true; end if;
    if coalesce((v_summary ->> 'workedMinutes')::numeric, 0) > 0 then return false; end if;
    if coalesce(v_summary ->> 'dayType', 'working') in ('weekly_rest', 'public_holiday') then return false; end if;

    -- live: still clocked in (or the hours wait for review) - the same start, minimum and permission
    select s.clock_in_at, coalesce(s.site_id, s.responsible_site_id) as site_id, s.organization_id into v_first
    from attendance_sessions s
    where s.user_id = p_user
      and s.clock_in_at >= (p_day - 1)::timestamp and s.clock_in_at < (p_day + 2)::timestamp
      and public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) = p_day
    order by s.clock_in_at
    limit 1;
    if v_first.clock_in_at is null then return false; end if;
    if exists (select 1 from attendance_permissions ap where ap.user_id = p_user and ap.work_date = p_day
               and ap.status = 'approved' and ap.kind = 'late_arrival' and ap.paid) then
        return false;
    end if;
    v_start := coalesce((select sa.start_time from shift_assignments sa where sa.user_id = p_user and sa.shift_date = p_day and sa.status = 'scheduled' order by sa.start_time limit 1),
                        public.prosm_time_late_from(v_first.site_id, v_first.organization_id));
    if v_start is null then return false; end if;
    v_tz := public.prosm_time_site_timezone(v_first.site_id, v_first.organization_id);
    v_min := coalesce((public.prosm_time_overtime_policy(p_user, v_first.site_id, p_day) ->> 'minLateMinutes')::numeric, 0);
    return extract(epoch from (v_first.clock_in_at - ((p_day + v_start) at time zone v_tz))) / 60 > v_min;
end;
$$;
revoke all on function public.prosm_time_late_today(uuid, date) from public, anon;
grant execute on function public.prosm_time_late_today(uuid, date) to authenticated, service_role;

-- the page: lateness (count, list and minutes) from the same rule
do $do$
declare
    v_def text := pg_get_functiondef('public.get_prosm_time_daily_summary(date)'::regprocedure);
    v_old text := $o$case when pl.start_time is not null
                     and (p.first_in at time zone p.tz)::time > pl.start_time + make_interval(mins => pl.grace)
                    then round(extract(epoch from ((p.first_in at time zone p.tz)::time - pl.start_time)) / 60)::int end as late_minutes$o$;
    v_new text := $n$case when public.prosm_time_late_today(p.user_id, p_date)
                    then greatest(round(coalesce((public.prosm_time_day_summary(p.user_id, p_date) ->> 'lateMinutes')::numeric, 0))::int,
                                  coalesce(round(extract(epoch from ((p.first_in at time zone p.tz)::time - pl.start_time)) / 60)::int, 0), 1) end as late_minutes$n$;
begin
    if position(v_old in v_def) = 0 then raise exception 'daily summary: lateness anchor not found'; end if;
    execute replace(v_def, v_old, v_new);
end $do$;

commit;
