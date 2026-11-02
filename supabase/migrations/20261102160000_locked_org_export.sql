-- 2026-11-02 (plan stage 3.3): after a licence ends the organisation stays locked,
-- but its owner can still read their attendance record out, read-only. This is one
-- door for the owner of a locked organisation; the lock itself does not change.
-- Rollback: drop the function.

begin;

create or replace function public.export_prosm_time_locked_attendance()
returns table (employee text, site text, clock_in_at timestamptz, clock_out_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_org uuid;
begin
    select u.organization_id into v_org from users u where u.auth_user_id = auth.uid() and u.is_active and u.is_owner;
    if v_org is null then raise exception 'ONLY THE OWNER CAN DO THIS'; end if;
    if not public.prosm_time_org_locked(v_org) then raise exception 'ORGANIZATION IS NOT LOCKED'; end if;
    return query
    select u.full_name, coalesce(s.name, ats.manual_location_label), ats.clock_in_at, ats.clock_out_at
    from attendance_sessions ats
    join users u on u.id = ats.user_id
    left join sites s on s.id = ats.site_id
    where ats.organization_id = v_org
    order by ats.clock_in_at desc
    limit 100000;
end;
$$;
revoke all on function public.export_prosm_time_locked_attendance() from public, anon;
grant execute on function public.export_prosm_time_locked_attendance() to authenticated;

commit;
