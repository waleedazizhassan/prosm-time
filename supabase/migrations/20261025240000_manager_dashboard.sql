-- PROSM Time v2.3.43, step 17 (items 5 and 4): the Owner/Manager dashboard -
-- exceptions first, the site at the centre. One read, scoped on the server:
-- the Owner sees the organisation, a Manager the sites they manage, "me" the
-- caller alone; a period (day/week/month/custom) and a site filter apply to
-- the figures, never to "who is here now" and the map (a live snapshot).
-- Nothing is invented: a comparison with the previous period is returned
-- only when that period has data; the estimated cost only for
-- payroll.view_cost (the Owner by default) and it leaves pending hours out;
-- external workers are counted apart from employees.
-- New permissions (matrix of the prompt): dashboard.view, payroll.view_cost,
-- external_labor.view, audit.view, sos.acknowledge, reports.export.

begin;

insert into public.permissions (permission_key, resource, action_type, name, description) values
    ('dashboard.view', 'dashboard', 'VIEW', 'Manager dashboard', 'The dashboard of the sites one manages (the organisation for the Owner).'),
    ('payroll.view_cost', 'payroll', 'VIEW', 'Costs and pay', 'Estimated cost, pay and allowance amounts.'),
    ('external_labor.view', 'external_labor', 'VIEW', 'External workers', 'External workers at the sites one manages.'),
    ('audit.view', 'audit', 'VIEW', 'Action log', 'The log of actions at the sites one manages.'),
    ('sos.acknowledge', 'sos', 'EXECUTE', 'Acknowledge SOS', 'Acknowledge an SOS alert at the sites one manages.'),
    ('reports.export', 'reports', 'EXPORT', 'Export reports', 'Export reports for the sites one manages.')
on conflict (permission_key) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p
  on p.permission_key in ('dashboard.view', 'external_labor.view', 'audit.view', 'sos.acknowledge', 'reports.export')
where r.role_key in ('owner', 'manager')
on conflict (role_id, permission_id) do nothing;

insert into public.role_default_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.permission_key = 'payroll.view_cost'
where r.role_key = 'owner'
on conflict (role_id, permission_id) do nothing;

-- Personal widget layout (hidden / order), kept per user on the server.
create table if not exists public.dashboard_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    layout jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);
alter table public.dashboard_preferences enable row level security;
revoke all on public.dashboard_preferences from anon, authenticated;
grant select on public.dashboard_preferences to authenticated;
drop policy if exists "dashboard preferences visible to their owner" on public.dashboard_preferences;
create policy "dashboard preferences visible to their owner" on public.dashboard_preferences
for select to authenticated using (user_id = public.current_prosm_time_user_id());

create or replace function public.save_prosm_time_dashboard_layout(p_layout jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_layout is null or jsonb_typeof(p_layout) <> 'object' or length(p_layout::text) > 4000 then raise exception 'INVALID LAYOUT'; end if;
    insert into dashboard_preferences (user_id, organization_id, layout) values (v_caller, public.current_prosm_time_organization_id(), p_layout)
    on conflict (user_id) do update set layout = excluded.layout, updated_at = now();
    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.save_prosm_time_dashboard_layout(jsonb) from public, anon;
grant execute on function public.save_prosm_time_dashboard_layout(jsonb) to authenticated;

-- ------------------------------------------------------------------
-- The dashboard.
-- ------------------------------------------------------------------
create or replace function public.get_prosm_time_manager_dashboard(
    p_from date,
    p_to date,
    p_scope text default 'org',
    p_site_id uuid default null,
    p_time_zone text default 'Africa/Cairo'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_owner boolean := public.current_prosm_time_user_is_owner();
    v_tz text := coalesce((select name from pg_timezone_names where name = p_time_zone limit 1), 'Africa/Cairo');
    v_today date;
    v_days integer;
    v_prev_from date;
    v_prev_to date;
    v_cost boolean;
    v_external boolean;
    v_audit boolean;
    v_alert_hours integer := coalesce((select open_session_alert_hours from organization_settings where organization_id = v_org), 12);
    v_sites uuid[];
    v_team uuid[];
    v_result jsonb;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (v_owner or public.prosm_time_user_has_permission_internal(v_caller, 'dashboard.view')) then
        raise exception 'DASHBOARD.VIEW AUTHORITY REQUIRED';
    end if;
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'CHOOSE A PERIOD OF UP TO A YEAR'; end if;
    v_today := (now() at time zone v_tz)::date;
    v_days := p_to - p_from + 1;
    v_prev_to := p_from - 1;
    v_prev_from := p_from - v_days;
    v_cost := v_owner or public.prosm_time_user_has_permission_internal(v_caller, 'payroll.view_cost');
    v_external := v_owner or public.prosm_time_user_has_permission_internal(v_caller, 'external_labor.view');
    v_audit := v_owner or public.prosm_time_user_has_permission_internal(v_caller, 'audit.view');

    -- the sites in scope
    select coalesce(array_agg(s.id), array[]::uuid[]) into v_sites
    from sites s
    where s.organization_id = v_org and s.is_active
      and (v_owner and coalesce(p_scope, 'org') = 'org' or s.id = any(public.current_prosm_time_managed_site_ids()))
      and (p_site_id is null or s.id = p_site_id);

    -- the people in scope (never the Owner: the Owner does not clock in)
    if p_scope = 'me' then
        v_team := array[v_caller];
    else
        select coalesce(array_agg(u.id), array[]::uuid[]) into v_team
        from users u
        where u.organization_id = v_org and u.is_active and not u.is_owner and u.id <> v_caller
          and (
              (v_owner and coalesce(p_scope, 'org') = 'org' and p_site_id is null)
              or exists (select 1 from site_assignments sa where sa.user_id = u.id and sa.site_id = any(v_sites))
          )
          and public.prosm_time_caller_sees_person(u.id);
    end if;

    with
    team as (select unnest(v_team) as id),
    open_now as (
        select s.*, u.full_name, u.avatar_url,
               exists (select 1 from break_events b where b.attendance_session_id = s.id and b.status = 'active') as on_break,
               exists (select 1 from presence_sessions p where p.attendance_session_id = s.id and p.status = 'active' and p.outside_since is not null) as outside
        from attendance_sessions s join users u on u.id = s.user_id
        where s.status = 'clocked_in' and s.user_id = any(v_team)
    ),
    period_sessions as (
        select s.*, public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) as work_date
        from attendance_sessions s
        where s.user_id = any(v_team)
          and s.clock_in_at >= ((p_from - 1)::timestamp at time zone v_tz) and s.clock_in_at < ((p_to + 2)::timestamp at time zone v_tz)
    ),
    days_worked as (
        select distinct user_id, work_date from period_sessions where work_date between p_from and p_to
    ),
    prev_sessions as (
        select s.*, public.prosm_time_work_date(s.clock_in_at, s.site_id, s.organization_id) as work_date
        from attendance_sessions s
        where s.user_id = any(v_team)
          and s.clock_in_at >= ((v_prev_from - 1)::timestamp at time zone v_tz) and s.clock_in_at < ((v_prev_to + 2)::timestamp at time zone v_tz)
    ),
    summaries as (
        select d.user_id, d.work_date, public.prosm_time_day_summary(d.user_id, d.work_date) as s from days_worked d
    ),
    prev_summaries as (
        select d.user_id, d.work_date, public.prosm_time_day_summary(d.user_id, d.work_date) as s
        from (select distinct user_id, work_date from prev_sessions where work_date between v_prev_from and v_prev_to) d
    ),
    expected_today as (
        select distinct sa.user_id from shift_assignments sa
        where sa.user_id = any(v_team) and sa.status = 'scheduled' and sa.shift_date = v_today
          and not exists (select 1 from leave_requests l where l.user_id = sa.user_id and l.status = 'approved' and v_today between l.start_date and l.end_date)
    ),
    on_leave_today as (
        select distinct l.user_id from leave_requests l where l.user_id = any(v_team) and l.status = 'approved' and v_today between l.start_date and l.end_date
    ),
    worked_today as (select distinct user_id from period_sessions where work_date = v_today),
    late_today as (select user_id from summaries where work_date = v_today and (s ->> 'lateMinutes')::numeric > 0),
    scheduled_minutes as (
        select sa.shift_date as day, sum(extract(epoch from (case when sa.end_time > sa.start_time then sa.end_time - sa.start_time else sa.end_time - sa.start_time + interval '24 hours' end)) / 60) as minutes
        from shift_assignments sa
        where sa.user_id = any(v_team) and sa.status = 'scheduled' and sa.shift_date between p_from and p_to
        group by sa.shift_date
    ),
    rates as (
        select distinct on (w.user_id) w.user_id, w.rate_type, w.rate_amount
        from worker_pay_rates w where w.user_id = any(v_team) and w.effective_from <= p_to and (w.effective_to is null or w.effective_to >= p_from)
        order by w.user_id, w.effective_from desc
    )
    select jsonb_build_object(
        'asOf', now(),
        'scope', coalesce(p_scope, 'org'),
        'canViewCost', v_cost,
        'canViewExternal', v_external,
        'canViewAudit', v_audit,
        'teamSize', cardinality(v_team),

        'sos', coalesce((
            select jsonb_agg(jsonb_build_object('id', a.id, 'userId', a.user_id, 'name', u.full_name, 'siteName', coalesce(a.site_name, st.name),
                                                'triggeredAt', a.triggered_at, 'latitude', a.latitude, 'longitude', a.longitude) order by a.triggered_at desc)
            from sos_alerts a join users u on u.id = a.user_id left join sites st on st.id = a.site_id
            where a.organization_id = v_org and a.status = 'active' and (a.user_id = any(v_team) or a.site_id = any(v_sites))
        ), '[]'::jsonb),

        'priorities', jsonb_build_object(
            'longSessions', (select count(*) from open_now o where o.clock_in_at <= now() - make_interval(hours => v_alert_hours)),
            'pendingHours', (select count(*) from attendance_sessions s where s.user_id = any(v_team) and s.hours_review_status = 'pending'),
            'outsideZone', (select count(*) from open_now o where o.outside),
            'leave', (select count(*) from leave_requests l where l.user_id = any(v_team) and l.status = 'pending'),
            'allowanceSheets', (select count(*) from allowance_sheets a where a.user_id = any(v_team) and a.status = 'submitted'),
            'corrections', (select count(*) from correction_requests c where c.user_id = any(v_team) and c.status = 'pending'),
            'timesheets', (select count(*) from timesheets t where t.user_id = any(v_team) and t.status = 'submitted'),
            'integrity', (select count(*) from integrity_flags f where f.user_id = any(v_team) and f.status = 'pending_review'),
            'permissions', (select count(*) from attendance_permissions p where p.user_id = any(v_team) and p.status = 'pending'),
            'outsideExceptions', (select count(*) from geofence_exceptions g where g.user_id = any(v_team) and g.status = 'pending_review')
        ),

        'kpi', jsonb_build_object(
            'presentNow', (select count(*) from open_now),
            'expectedToday', (select count(*) from expected_today),
            'hasSchedule', exists (select 1 from shift_assignments sa where sa.user_id = any(v_team) and sa.shift_date between p_from and p_to),
            'onLeaveToday', (select count(*) from on_leave_today),
            'lateToday', (select count(*) from late_today),
            'absentToday', (select count(*) from expected_today e where e.user_id not in (select user_id from worked_today)),
            'workedMinutes', coalesce((select sum((s ->> 'workedMinutes')::numeric) from summaries), 0),
            'scheduledMinutes', coalesce((select sum(minutes) from scheduled_minutes), 0),
            'overtimeMinutes', coalesce((select sum((s ->> 'overtimeMinutes')::numeric) from summaries), 0),
            'lateCount', (select count(*) from summaries where (s ->> 'lateMinutes')::numeric > 0),
            'pendingMinutes', coalesce((select sum(extract(epoch from (clock_out_at - clock_in_at)) / 60) from period_sessions where hours_review_status = 'pending' and work_date between p_from and p_to), 0),
            'previous', case when exists (select 1 from prev_summaries) then jsonb_build_object(
                'workedMinutes', coalesce((select sum((s ->> 'workedMinutes')::numeric) from prev_summaries), 0),
                'overtimeMinutes', coalesce((select sum((s ->> 'overtimeMinutes')::numeric) from prev_summaries), 0),
                'lateCount', (select count(*) from prev_summaries where (s ->> 'lateMinutes')::numeric > 0)
            ) else null end,
            'estimatedCost', case when v_cost then round(coalesce((
                select sum(case r.rate_type when 'HOURLY' then r.rate_amount * (sm.s ->> 'workedMinutes')::numeric / 60
                                            else r.rate_amount / coalesce((select unpaid_leave_divisor from organization_settings where organization_id = v_org), 30) end)
                from summaries sm join rates r on r.user_id = sm.user_id
            ), 0) + coalesce((
                select sum(public.prosm_time_entry_total(e)) from allowance_entries e
                where e.user_id = any(v_team) and e.entry_date between p_from and p_to and e.status in ('submitted', 'approved')
            ), 0), 2) else null end
        ),

        'presentNow', coalesce((
            select jsonb_agg(jsonb_build_object('userId', o.user_id, 'name', o.full_name, 'avatarUrl', o.avatar_url, 'clockInAt', o.clock_in_at,
                                                'siteId', o.site_id, 'siteName', coalesce((select name from sites where id = o.site_id), o.manual_location_label),
                                                'status', case when o.clock_in_at <= now() - make_interval(hours => v_alert_hours) then 'long'
                                                               when o.on_break then 'break' when o.outside then 'outside' else 'in' end,
                                                'latitude', (select e.latitude from attendance_events e where e.session_id = o.id and e.event_type = 'clock_in' limit 1),
                                                'longitude', (select e.longitude from attendance_events e where e.session_id = o.id and e.event_type = 'clock_in' limit 1),
                                                'lastLatitude', (select ls.latitude from location_samples ls join presence_sessions p on p.id = ls.presence_session_id where p.attendance_session_id = o.id order by ls.captured_at desc limit 1),
                                                'lastLongitude', (select ls.longitude from location_samples ls join presence_sessions p on p.id = ls.presence_session_id where p.attendance_session_id = o.id order by ls.captured_at desc limit 1),
                                                'timezone', public.prosm_time_site_timezone(o.site_id, o.organization_id))
                             order by o.clock_in_at)
            from open_now o
        ), '[]'::jsonb),

        'sites', coalesce((
            select jsonb_agg(x.site order by x.name)
            from (
                select st.name, jsonb_build_object(
                    'id', st.id, 'name', st.name, 'latitude', st.latitude, 'longitude', st.longitude, 'radius', st.allowed_radius_meters,
                    'present', (select count(*) from open_now o where o.site_id = st.id),
                    'expected', (select count(distinct sa.user_id) from shift_assignments sa where sa.site_id = st.id and sa.shift_date = v_today and sa.status = 'scheduled' and sa.user_id = any(v_team)),
                    'late', (select count(*) from summaries sm where sm.work_date = v_today and (sm.s ->> 'siteId')::uuid = st.id and (sm.s ->> 'lateMinutes')::numeric > 0),
                    'absent', (select count(distinct sa.user_id) from shift_assignments sa where sa.site_id = st.id and sa.shift_date = v_today and sa.status = 'scheduled' and sa.user_id = any(v_team)
                                 and sa.user_id not in (select user_id from worked_today) and sa.user_id not in (select user_id from on_leave_today)),
                    'workedMinutes', coalesce((select sum((sm.s ->> 'workedMinutes')::numeric) from summaries sm where (sm.s ->> 'siteId')::uuid = st.id), 0),
                    'overtimeMinutes', coalesce((select sum((sm.s ->> 'overtimeMinutes')::numeric) from summaries sm where (sm.s ->> 'siteId')::uuid = st.id), 0),
                    'sos', exists (select 1 from sos_alerts a where a.site_id = st.id and a.status = 'active'),
                    'outside', (select count(*) from open_now o where o.site_id = st.id and o.outside),
                    'cost', case when v_cost then round(coalesce((
                        select sum(case r.rate_type when 'HOURLY' then r.rate_amount * (sm.s ->> 'workedMinutes')::numeric / 60 else r.rate_amount / 30 end)
                        from summaries sm join rates r on r.user_id = sm.user_id where (sm.s ->> 'siteId')::uuid = st.id
                    ), 0), 2) else null end,
                    'external', case when v_external then jsonb_build_object(
                        'presentNow', (select count(*) from site_worker_attendance a where a.site_id = st.id and a.clock_out_at is null),
                        'today', (select count(distinct a.site_worker_id) from site_worker_attendance a where a.site_id = st.id
                                    and (a.clock_in_at at time zone v_tz)::date = v_today),
                        'minutesToday', coalesce((select sum(extract(epoch from (coalesce(a.clock_out_at, now()) - a.clock_in_at)) / 60) from site_worker_attendance a
                                                  where a.site_id = st.id and (a.clock_in_at at time zone v_tz)::date = v_today), 0),
                        'contractors', coalesce((
                            select jsonb_agg(jsonb_build_object('name', c.contractor, 'present', c.present, 'today', c.today) order by c.contractor)
                            from (
                                select coalesce(w.contractor_name, '') as contractor,
                                       count(*) filter (where a.clock_out_at is null) as present,
                                       count(distinct a.site_worker_id) as today
                                from site_worker_attendance a join site_workers w on w.id = a.site_worker_id
                                where a.site_id = st.id and (a.clock_in_at at time zone v_tz)::date = v_today
                                group by coalesce(w.contractor_name, '')
                            ) c
                        ), '[]'::jsonb)
                    ) else null end
                ) as site
                from sites st where st.id = any(v_sites)
            ) x
        ), '[]'::jsonb),

        'chart', coalesce((
            select jsonb_agg(jsonb_build_object(
                'day', d::date,
                'workedMinutes', coalesce((select sum((sm.s ->> 'workedMinutes')::numeric) from summaries sm where sm.work_date = d::date), 0),
                'scheduledMinutes', coalesce((select minutes from scheduled_minutes where day = d::date), 0),
                'pendingMinutes', coalesce((select sum(extract(epoch from (clock_out_at - clock_in_at)) / 60) from period_sessions ps where ps.work_date = d::date and ps.hours_review_status = 'pending'), 0),
                'late', (select count(*) from summaries sm where sm.work_date = d::date and (sm.s ->> 'lateMinutes')::numeric > 0),
                'absent', (select count(distinct sa.user_id) from shift_assignments sa where sa.user_id = any(v_team) and sa.shift_date = d::date and sa.status = 'scheduled'
                             and d::date <= v_today
                             and not exists (select 1 from period_sessions ps where ps.user_id = sa.user_id and ps.work_date = d::date)
                             and not exists (select 1 from leave_requests l where l.user_id = sa.user_id and l.status = 'approved' and d::date between l.start_date and l.end_date))
            ) order by d)
            from generate_series(p_from, p_to, interval '1 day') d
            where v_days <= 62
        ), '[]'::jsonb),

        -- a longer period (the yearly view): one bar per month
        'chartMonthly', coalesce((
            select jsonb_agg(jsonb_build_object('month', m.month, 'workedMinutes', m.worked, 'overtimeMinutes', m.overtime, 'late', m.late) order by m.month)
            from (
                select to_char(sm.work_date, 'YYYY-MM') as month,
                       sum((sm.s ->> 'workedMinutes')::numeric) as worked,
                       sum((sm.s ->> 'overtimeMinutes')::numeric) as overtime,
                       count(*) filter (where (sm.s ->> 'lateMinutes')::numeric > 0) as late
                from summaries sm group by 1
            ) m
            where v_days > 62
        ), '[]'::jsonb),

        'allowances', case when v_cost then jsonb_build_object(
            'total', coalesce((select sum(public.prosm_time_entry_total(e)) from allowance_entries e where e.user_id = any(v_team) and e.entry_date between p_from and p_to and e.status in ('submitted', 'approved')), 0),
            'overtimeAmount', coalesce((select sum(e.overtime_amount) from allowance_entries e where e.user_id = any(v_team) and e.entry_date between p_from and p_to and e.status in ('submitted', 'approved')), 0),
            'overtimeMinutes', coalesce((select sum(e.overtime_minutes) from allowance_entries e where e.user_id = any(v_team) and e.entry_date between p_from and p_to and e.status in ('submitted', 'approved')), 0),
            'deductions', coalesce((select sum(a.amount) from payroll_adjustments a where a.user_id = any(v_team) and a.status = 'active' and a.work_date between p_from and p_to), 0)
        ) else null end,

        'audit', case when v_audit then coalesce((
            select jsonb_agg(row_to_json(l)::jsonb order by l.created_at desc) from (
                select al.id, al.created_at, al.action, al.reason, al.description,
                       actor.full_name as actor_name, subject.full_name as subject_name, subject.id as subject_id,
                       al.context ->> 'siteId' as site_id, al.context ->> 'deviceInfo' as device
                from audit_logs al
                left join users actor on actor.id = al.actor_user_id
                left join users subject on subject.id = al.subject_user_id
                where al.organization_id = v_org
                  and (v_owner and coalesce(p_scope, 'org') = 'org' and p_site_id is null or al.subject_user_id = any(v_team) or al.actor_user_id = v_caller)
                order by al.created_at desc
                limit 10
            ) l
        ), '[]'::jsonb) else null end,

        'holidays', coalesce((
            select jsonb_agg(jsonb_build_object('name', h.name, 'startDate', h.start_date, 'endDate', h.end_date) order by h.start_date)
            from public_holidays h
            where h.organization_id = v_org and h.end_date >= v_today and h.start_date <= v_today + 30
              and (h.site_id is null or h.site_id = any(v_sites))
        ), '[]'::jsonb)
    ) into v_result;

    return v_result;
end;
$function$;

revoke all on function public.get_prosm_time_manager_dashboard(date, date, text, uuid, text) from public, anon;
grant execute on function public.get_prosm_time_manager_dashboard(date, date, text, uuid, text) to authenticated;


-- sos.acknowledge now lets its holder mark an SOS handled (still only at
-- the sites they manage; the older two authorities keep working).
CREATE OR REPLACE FUNCTION public.resolve_prosm_time_sos_alert(p_sos_alert_id uuid, p_resolution_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_caller_id uuid;
    v_caller_org uuid;
    v_alert sos_alerts%rowtype;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_caller_org := public.current_prosm_time_organization_id();

    if v_caller_id is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;

    if not (
        public.current_prosm_time_user_is_owner()
        or 'attendance.clock_out_on_behalf' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        or 'exceptions.manage' = any(coalesce(public.get_prosm_time_effective_permissions(v_caller_id), array[]::text[]))
        or public.prosm_time_user_has_permission_internal(v_caller_id, 'sos.acknowledge')
    ) then
        raise exception 'ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED';
    end if;

    select * into v_alert from sos_alerts where id = p_sos_alert_id and organization_id = v_caller_org;
    if v_alert.id is null then
        raise exception 'SOS ALERT NOT FOUND';
    end if;
    -- An emergency: anyone in charge of the alert's site may mark it handled (no rank rule).
    if not (
        public.current_prosm_time_user_is_owner()
        or v_alert.site_id = any(public.current_prosm_time_managed_site_ids())
        or (v_alert.site_id is null and public.current_prosm_time_caller_manages_users_site(v_alert.user_id))
    ) then
        raise exception 'YOU DO NOT MANAGE THIS EMPLOYEES SITE';
    end if;

    if v_alert.status <> 'active' then
        raise exception 'THIS SOS ALERT IS ALREADY RESOLVED';
    end if;

    update sos_alerts
    set status = 'resolved', resolved_at = now(), resolved_by = v_caller_id, resolution_notes = p_resolution_notes
    where id = p_sos_alert_id;

    insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, entity_id, description)
    values (
        v_caller_org, v_caller_id, v_alert.user_id, 'SOS_ALERT_RESOLVED', 'sos_alerts', p_sos_alert_id,
        'SOS alert marked resolved.'
    );

    return jsonb_build_object('success', true);
exception
    when others then
        raise exception 'RESOLVE PROSM TIME SOS ALERT FAILED: %', sqlerrm;
end;
$function$;

revoke execute on function public.resolve_prosm_time_sos_alert(uuid, text) from public, anon;
grant execute on function public.resolve_prosm_time_sos_alert(uuid, text) to authenticated;

commit;
