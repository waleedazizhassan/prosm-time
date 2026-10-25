-- PROSM Time v2.3.43, steps 14-15 (items 17 and 18): one read for the people
-- the caller may see (the same people as list_prosm_time_visible_members),
-- with what lists show beside a name: the profile photo (users.avatar_url -
-- never an attendance evidence photo), the role and its order, the sites,
-- the live status (in / on break / out) and today's shift.
-- roles.sort_order gives the order of the role groups: managers (the Owner
-- with them), supervisors, employees, viewers; roles added later sort by
-- their own number, then by name.

begin;

alter table public.roles add column if not exists sort_order integer not null default 100;
update public.roles set sort_order = case role_key
    when 'owner' then 10 when 'manager' then 20 when 'supervisor' then 30 when 'employee' then 40 when 'read_only' then 50 else sort_order end;

create or replace function public.list_prosm_time_people_directory()
returns table (
    id uuid, full_name text, email text, avatar_url text, is_owner boolean, is_active boolean,
    role_key text, role_name text, role_sort integer,
    site_ids uuid[], site_names text[],
    presence text, clock_in_at timestamptz, current_site_name text,
    shift_start time, shift_end time
)
language sql
stable
security definer
set search_path = public
as $function$
    select u.id, u.full_name, u.email, u.avatar_url, u.is_owner, u.is_active,
           vm.role_key, vm.role_name, coalesce(r.sort_order, 100),
           coalesce((select array_agg(s.id order by s.name) from site_assignments sa join sites s on s.id = sa.site_id where sa.user_id = u.id), array[]::uuid[]),
           coalesce((select array_agg(s.name order by s.name) from site_assignments sa join sites s on s.id = sa.site_id where sa.user_id = u.id), array[]::text[]),
           case
               when open_s.id is null then 'out'
               when exists (select 1 from break_events b where b.attendance_session_id = open_s.id and b.status = 'active') then 'break'
               else 'in'
           end,
           open_s.clock_in_at,
           coalesce((select name from sites where id = open_s.site_id), open_s.manual_location_label),
           shift.start_time, shift.end_time
    from public.list_prosm_time_visible_members() vm
    join users u on u.id = vm.id
    left join roles r on r.role_key = vm.role_key
    left join lateral (select * from attendance_sessions s where s.user_id = u.id and s.status = 'clocked_in' limit 1) open_s on true
    left join lateral (
        select sa.start_time, sa.end_time from shift_assignments sa
        where sa.user_id = u.id and sa.status = 'scheduled'
          and sa.shift_date = (now() at time zone public.prosm_time_site_timezone(sa.site_id, u.organization_id))::date
        order by sa.start_time limit 1
    ) shift on true;
$function$;

revoke all on function public.list_prosm_time_people_directory() from public, anon;
grant execute on function public.list_prosm_time_people_directory() to authenticated;

commit;
