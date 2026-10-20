-- Owner 2026-10-20: the dashboard showed two people "on break" a week after
-- their shifts had ended. Some ways of ending a shift (on someone's behalf,
-- an approved clock-out correction, an offline clock-out sent later) left an
-- open break behind. Now a break can never outlive its shift: whenever a
-- shift is clocked out, by any path, its open breaks end at the shift's
-- clock-out time. Breaks already left open are closed the same way.

begin;

create or replace function public.prosm_time_end_breaks_with_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
    if new.status = 'clocked_out' and old.status is distinct from 'clocked_out' then
        update break_events
        set status = 'ended', ended_at = coalesce(new.clock_out_at, now())
        where attendance_session_id = new.id and status = 'active';
    end if;
    return new;
end;
$function$;

revoke execute on function public.prosm_time_end_breaks_with_shift() from public, anon, authenticated;

drop trigger if exists attendance_sessions_end_breaks on public.attendance_sessions;
create trigger attendance_sessions_end_breaks
after update of status on public.attendance_sessions
for each row execute function public.prosm_time_end_breaks_with_shift();

update public.break_events b
set status = 'ended', ended_at = coalesce(s.clock_out_at, b.started_at)
from public.attendance_sessions s
where s.id = b.attendance_session_id and b.status = 'active' and s.status = 'clocked_out';

commit;
