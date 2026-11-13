-- Owner 2026-11-13: "prevent scheduling any employee at a site they are not assigned to, and show a message saying
-- why." One guard on shift_assignments covers every way a shift is given to someone - scheduling, an open shift
-- taken, a swap approved: a scheduled shift is accepted only for a person assigned to its site. Shifts that already
-- exist are left as they are (the guard runs when a shift is added, or its person or site changes). The owner,
-- who works at any site, is not held to it.
-- The swap list follows the same rule: only colleagues assigned to the shift's site (20261113190000 also offered
-- colleagues of one's own sites).
-- Rollback: drop trigger shift_assignments_assigned_site and function prosm_time_guard_shift_site; restore
-- prosm_time_swap_candidates from 20261113190000.

begin;

create or replace function public.prosm_time_guard_shift_site()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status = 'scheduled'
       and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id or new.site_id is distinct from old.site_id)
       and not exists (select 1 from site_assignments sa where sa.site_id = new.site_id and sa.user_id = new.user_id)
       -- the owner works at any site
       and not exists (select 1 from users u where u.id = new.user_id and u.is_owner) then
        raise exception 'THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_guard_shift_site() from public, anon, authenticated;

drop trigger if exists shift_assignments_assigned_site on public.shift_assignments;
create trigger shift_assignments_assigned_site
    before insert or update of user_id, site_id, status on public.shift_assignments
    for each row execute function public.prosm_time_guard_shift_site();

create or replace function public.prosm_time_swap_candidates(p_assignment_id uuid)
returns table (user_id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
    with v as (select * from shift_assignments where id = p_assignment_id)
    select u.id, u.full_name
    from v
    join users u on u.organization_id = v.organization_id
    left join roles r on r.id = u.role_id
    where u.id <> v.user_id and u.status = 'active' and u.is_active and not u.is_owner
      and coalesce(r.role_key, 'employee') <> 'read_only'
      and exists (select 1 from site_assignments sa where sa.site_id = v.site_id and sa.user_id = u.id)
      and not exists (select 1 from leave_requests l where l.user_id = u.id and l.status = 'approved' and v.shift_date between l.start_date and l.end_date)
      and not exists (select 1 from shift_assignments o where o.user_id = u.id and o.shift_date = v.shift_date and o.status = 'scheduled'
                      and (o.start_time, o.end_time) overlaps (v.start_time, v.end_time))
    order by u.full_name;
$$;

commit;
