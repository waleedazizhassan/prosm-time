-- Owner 2026-11-13: "'Choose a colleague' holds only its own words, and 'Request the swap' stays off; the shift's
-- site shows empty." The person was scheduled at a site they are not assigned to: the site's name was not
-- readable to them, and the list took only the site's assigned people - nobody else there.
-- The people one can swap with now: active colleagues (not the owner, not viewers) assigned to the shift's site
-- or scheduled there in the weeks around it - or, when there is nobody, colleagues of the requester's own sites,
-- or anyone when the requester has no site - who are not on approved leave that day and have no overlapping
-- scheduled shift that day. The request accepts exactly them. One's own shifts come with their site's name.
-- Rollback: restore list_prosm_time_swap_colleagues and request_prosm_time_shift_swap from 20261102120000;
-- drop prosm_time_swap_candidates and list_prosm_time_my_shifts.

begin;

create or replace function public.prosm_time_swap_candidates(p_assignment_id uuid)
returns table (user_id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
    with v as (select * from shift_assignments where id = p_assignment_id),
    free as (
        select u.id, u.full_name
        from v
        join users u on u.organization_id = v.organization_id
        left join roles r on r.id = u.role_id
        where u.id <> v.user_id and u.status = 'active' and u.is_active and not u.is_owner
          and coalesce(r.role_key, 'employee') <> 'read_only'
          and not exists (select 1 from leave_requests l where l.user_id = u.id and l.status = 'approved' and v.shift_date between l.start_date and l.end_date)
          and not exists (select 1 from shift_assignments o where o.user_id = u.id and o.shift_date = v.shift_date and o.status = 'scheduled'
                          and (o.start_time, o.end_time) overlaps (v.start_time, v.end_time))
    ),
    at_site as (
        select f.id, f.full_name from free f, v
        where exists (select 1 from site_assignments sa where sa.site_id = v.site_id and sa.user_id = f.id)
           or exists (select 1 from shift_assignments o where o.user_id = f.id and o.site_id = v.site_id and o.shift_date between v.shift_date - 21 and v.shift_date + 21)
    ),
    my_sites as (
        select f.id, f.full_name from free f, v
        where exists (select 1 from site_assignments mine join site_assignments theirs on theirs.site_id = mine.site_id
                      where mine.user_id = v.user_id and theirs.user_id = f.id)
    )
    select id, full_name from at_site
    union
    select id, full_name from my_sites where not exists (select 1 from at_site)
    union
    select id, full_name from free
    where not exists (select 1 from at_site) and not exists (select 1 from my_sites)
      and not exists (select 1 from site_assignments mine, v where mine.user_id = v.user_id)
    order by 2;
$$;
revoke all on function public.prosm_time_swap_candidates(uuid) from public, anon, authenticated;

create or replace function public.list_prosm_time_swap_colleagues(p_assignment_id uuid)
returns table (user_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_shift shift_assignments%rowtype;
begin
    select * into v_shift from shift_assignments where id = p_assignment_id and organization_id = public.current_prosm_time_organization_id();
    if v_shift.id is null or v_shift.user_id <> public.current_prosm_time_user_id() then raise exception 'SHIFT NOT FOUND'; end if;
    return query select c.user_id, c.full_name from public.prosm_time_swap_candidates(p_assignment_id) c;
end;
$$;

do $$
declare
    v_def text := pg_get_functiondef('public.request_prosm_time_shift_swap(uuid, uuid, text)'::regprocedure);
    v_old text := 'if p_to_user_id = v_me or not exists (select 1 from site_assignments where site_id = v_shift.site_id and user_id = p_to_user_id) then';
begin
    if position(v_old in v_def) = 0 then raise exception 'request_prosm_time_shift_swap: anchor not found'; end if;
    execute replace(v_def, v_old,
        'if p_to_user_id = v_me or not exists (select 1 from public.prosm_time_swap_candidates(p_assignment_id) c where c.user_id = p_to_user_id) then');
end $$;

-- one's own shifts with their site's name (readable even at a site one is not assigned to)
create or replace function public.list_prosm_time_my_shifts()
returns table (id uuid, shift_date date, start_time time, end_time time, status text, notes text, cancelled_reason text, site_name text)
language sql
stable
security definer
set search_path = public
as $$
    select sa.id, sa.shift_date, sa.start_time, sa.end_time, sa.status, sa.notes, sa.cancelled_reason, s.name
    from shift_assignments sa left join sites s on s.id = sa.site_id
    where sa.user_id = public.current_prosm_time_user_id()
    order by sa.shift_date, sa.start_time;
$$;
revoke all on function public.list_prosm_time_my_shifts() from public, anon;
grant execute on function public.list_prosm_time_my_shifts() to authenticated;

commit;
