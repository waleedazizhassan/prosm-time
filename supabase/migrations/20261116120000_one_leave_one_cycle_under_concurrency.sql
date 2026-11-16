-- QA-009 / QA-010 (2026-11-16, real PostgreSQL, two connections at the same moment):
--   * two leave requests by the same person for the same day both went through (5 of 5 races): the "already have a
--     pending or approved leave overlapping these dates" rule was checked, then inserted, with nothing in between;
--   * two payroll cycles for the same period and scope were both created (2 of 3 races) - the same month could be
--     paid twice.
-- Same rules, same messages, now enforced at the moment of writing, whatever path writes: a trigger takes a lock
-- for that person (leave) or organisation (payroll cycles) for the rest of the transaction and checks again. The
-- second writer waits for the first, then sees its row and is refused.
-- On a leave status change only approved rows are compared (approving one of two older overlapping requests made
-- before this fix stays possible; approving both is not).
-- Rollback: drop the triggers leave_requests_no_overlap / payroll_cycles_no_overlap and their functions.

begin;

create or replace function public.prosm_time_leave_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status not in ('pending', 'approved') then return new; end if;
    if tg_op = 'UPDATE' and new.status = old.status and new.start_date = old.start_date and new.end_date = old.end_date then return new; end if;
    perform pg_advisory_xact_lock(hashtextextended('prosm_time_leave:' || new.user_id::text, 0));
    if exists (
        select 1 from leave_requests r
        where r.user_id = new.user_id and r.id <> new.id
          and r.status = any(case when tg_op = 'INSERT' then array['pending', 'approved'] else array['approved'] end)
          and new.start_date <= r.end_date and new.end_date >= r.start_date
    ) then
        raise exception 'YOU ALREADY HAVE A PENDING OR APPROVED LEAVE REQUEST OVERLAPPING THESE DATES';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_leave_no_overlap() from public, anon, authenticated;

drop trigger if exists leave_requests_no_overlap on public.leave_requests;
create trigger leave_requests_no_overlap before insert or update of status, start_date, end_date on public.leave_requests
    for each row execute function public.prosm_time_leave_no_overlap();

create or replace function public.prosm_time_payroll_cycle_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status = 'cancelled' then return new; end if;
    if tg_op = 'UPDATE' and old.status <> 'cancelled' and new.period_start = old.period_start and new.period_end = old.period_end
       and new.site_id is not distinct from old.site_id then return new; end if;
    perform pg_advisory_xact_lock(hashtextextended('prosm_time_payroll_cycle:' || new.organization_id::text, 0));
    -- one active cycle per scope and period; an organisation-wide cycle and a site cycle may not overlap
    if exists (
        select 1 from payroll_cycles c
        where c.organization_id = new.organization_id and c.id <> new.id and c.status <> 'cancelled'
          and c.period_start <= new.period_end and c.period_end >= new.period_start
          and (c.site_id is null or new.site_id is null or c.site_id = new.site_id)
    ) then
        raise exception 'AN ACTIVE PAYROLL CYCLE ALREADY COVERS THIS PERIOD AND SCOPE';
    end if;
    return new;
end;
$$;
revoke all on function public.prosm_time_payroll_cycle_no_overlap() from public, anon, authenticated;

drop trigger if exists payroll_cycles_no_overlap on public.payroll_cycles;
create trigger payroll_cycles_no_overlap before insert or update of status, period_start, period_end, site_id on public.payroll_cycles
    for each row execute function public.prosm_time_payroll_cycle_no_overlap();

commit;
