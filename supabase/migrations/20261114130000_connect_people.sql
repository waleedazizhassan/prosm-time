-- PROSM Connect (owner 2026-11-13): the conversation list shows everyone with their internal number and their
-- attendance status - "at <site>", "on a break", "out", "on leave" - so you know where someone is before you talk to
-- them. The people directory is for managers; an employee reads this short list instead, and only while their
-- organisation has Connect: name, picture, role, number, status and current site - nothing else of the HR file.
-- Rollback: drop function list_prosm_time_connect_people.

begin;

create or replace function public.list_prosm_time_connect_people()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with me as (select public.current_prosm_time_organization_id() as org),
    open_sessions as (
        select distinct on (a.user_id) a.user_id, a.id, a.clock_in_at, a.site_id
        from attendance_sessions a, me
        where a.organization_id = me.org and a.status = 'clocked_in'
        order by a.user_id, a.clock_in_at desc
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', u.id, 'fullName', u.full_name, 'avatarUrl', u.avatar_url, 'roleKey', r.role_key, 'roleName', r.name,
               'isOwner', u.is_owner, 'ext', x.ext,
               'presence', case
                   when o.id is not null and exists (select 1 from break_events b where b.attendance_session_id = o.id and b.status = 'active') then 'break'
                   when o.id is not null then 'in'
                   when exists (select 1 from leave_requests l where l.user_id = u.id and l.status = 'approved'
                                and (now() at time zone 'Africa/Cairo')::date between l.start_date and l.end_date) then 'leave'
                   else 'out' end,
               'clockInAt', o.clock_in_at,
               'currentSiteName', (select s.name from sites s where s.id = o.site_id),
               'siteNames', coalesce((select jsonb_agg(s.name order by s.name) from site_assignments sa join sites s on s.id = sa.site_id where sa.user_id = u.id), '[]'::jsonb)
           ) order by u.full_name), '[]'::jsonb)
    from users u
    join me on u.organization_id = me.org
    left join roles r on r.id = u.role_id
    left join connect_extensions x on x.user_id = u.id
    left join open_sessions o on o.user_id = u.id
    where u.is_active and u.status = 'active'
      and public.prosm_time_connect_enabled(me.org);
$$;
revoke all on function public.list_prosm_time_connect_people() from public, anon;
grant execute on function public.list_prosm_time_connect_people() to authenticated;

commit;
