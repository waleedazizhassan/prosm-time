-- Owner 2026-11-17: "the dashboard loads heavy". The approvals card asks for list_prosm_time_permission_queue every
-- minute (with every dashboard refresh); its "overtime awaiting approval" part ran the full pay calculation
-- (prosm_time_day_summary) for every person and every day of the last 35 days - about 600 calculations, ~1.1 s,
-- on each call, for each open dashboard.
-- Now the organisation's list is kept (private_cache.overtime_queue) and calculated again only when something it
-- depends on changes - a session, a break, a permission, a manager's day adjustment, an allowance, a timesheet, a
-- shift, a site, the organisation's settings or overtime policy - and at most 10 minutes old in any case. Each caller
-- still sees only the people they have authority over, never themselves. The result is the same as before.
-- Rollback: restore list_prosm_time_permission_queue from 20261117120000's chain (pg_get_functiondef before this),
-- drop the triggers prosm_time_overtime_queue_stale_* and schema private_cache cascade.
begin;

create schema if not exists private_cache;
revoke all on schema private_cache from public, anon, authenticated;

create table if not exists private_cache.overtime_queue (
    organization_id uuid primary key,
    computed_at timestamptz not null default now(),
    items jsonb not null
);
revoke all on private_cache.overtime_queue from public, anon, authenticated;

-- any change to what the list depends on: the organisation's list is calculated again on the next read
create or replace function public.prosm_time_overtime_queue_stale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from private_cache.overtime_queue
    where organization_id = case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
    return null;
end;
$$;
revoke all on function public.prosm_time_overtime_queue_stale() from public, anon, authenticated;

do $do$
declare
    v_table text;
begin
    foreach v_table in array array['attendance_sessions', 'break_events', 'attendance_permissions', 'attendance_day_adjustments',
                                   'allowance_entries', 'timesheets', 'shift_assignments', 'sites', 'organization_settings', 'overtime_policies']
    loop
        if to_regclass('public.' || v_table) is not null then
            execute format('drop trigger if exists prosm_time_overtime_queue_stale_%1$s on public.%1$I', v_table);
            execute format('create trigger prosm_time_overtime_queue_stale_%1$s after insert or update or delete on public.%1$I
                            for each row execute function public.prosm_time_overtime_queue_stale()', v_table);
        end if;
    end loop;
end $do$;

create or replace function public.list_prosm_time_permission_queue()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
    v_items jsonb;
begin
    if v_caller is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if not (public.prosm_time_user_has_permission_internal(v_caller, 'attendance.manage_permissions') or public.prosm_time_is_hr_approver(v_caller)) then
        return jsonb_build_object('requests', '[]'::jsonb, 'overtime', '[]'::jsonb);
    end if;

    -- the organisation's overtime awaiting approval: kept until something changes (or 10 minutes)
    select q.items into v_items from private_cache.overtime_queue q
    where q.organization_id = v_org and q.computed_at > now() - interval '10 minutes';
    if v_items is null then
        select coalesce(jsonb_agg(jsonb_build_object('userId', x.user_id, 'day', x.day, 'summary', x.summary) order by x.day), '[]'::jsonb)
        into v_items
        from (
            select d.user_id, d.day, public.prosm_time_day_summary(d.user_id, d.day) as summary
            from (
                select distinct ats.user_id, public.prosm_time_work_date(ats.clock_in_at, ats.site_id, ats.organization_id) as day
                from attendance_sessions ats
                where ats.organization_id = v_org and ats.status = 'clocked_out' and ats.clock_in_at > now() - interval '35 days'
            ) d
            where not exists (select 1 from allowance_entries e where e.user_id = d.user_id and e.entry_date = d.day and e.status = 'approved')
              and not exists (select 1 from timesheets ts where ts.user_id = d.user_id and ts.status in ('approved', 'locked') and d.day between ts.period_start and ts.period_end)
        ) x
        where (x.summary ->> 'overtimePendingApprovalMinutes')::numeric > 0;
        insert into private_cache.overtime_queue (organization_id, computed_at, items) values (v_org, now(), v_items)
        on conflict (organization_id) do update set computed_at = excluded.computed_at, items = excluded.items;
    end if;

    return jsonb_build_object(
        'requests', coalesce((
            select jsonb_agg(jsonb_build_object('id', p.id, 'userId', p.user_id, 'employeeName', u.full_name, 'avatarUrl', u.avatar_url,
                                                'workDate', p.work_date, 'kind', p.kind, 'minutes', p.minutes, 'reason', p.reason, 'createdAt', p.created_at)
                             order by p.created_at)
            from attendance_permissions p join users u on u.id = p.user_id
            where p.organization_id = v_org and p.status = 'pending' and p.user_id <> v_caller
              and public.prosm_time_request_decider('permission', v_caller, p.user_id,
                    public.prosm_time_request_effective_step('permission', v_org, p.user_id, p.approval_step))
        ), '[]'::jsonb),
        'overtime', coalesce((
            select jsonb_agg((i -> 'summary') || jsonb_build_object('userId', u.id, 'employeeName', u.full_name, 'avatarUrl', u.avatar_url)
                             order by i ->> 'day')
            from jsonb_array_elements(v_items) i
            join users u on u.id = (i ->> 'userId')::uuid
            where u.id <> v_caller and public.prosm_time_caller_has_authority_over(u.id)
        ), '[]'::jsonb)
    );
end;
$$;
revoke all on function public.list_prosm_time_permission_queue() from public, anon;
grant execute on function public.list_prosm_time_permission_queue() to authenticated, service_role;

commit;
