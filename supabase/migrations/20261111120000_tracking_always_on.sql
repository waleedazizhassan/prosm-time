-- 2026-11-11 (owner): "people move away from the sites and nothing happens" - following a person's
-- movement during a shift ran only at sites with "ongoing presence monitoring" switched on, and that
-- was off for every new site. It is now part of the product: on at every site, always (the setting is
-- gone and stays on whatever an older app sends), and everyone clocked in right now at a site starts
-- being followed at once. Following still happens only between clock-in and clock-out.
-- Rollback: drop trigger sites_tracking_always_on and its function; set the column default back to false.

begin;

update public.sites set presence_monitoring_enabled = true where not presence_monitoring_enabled;
alter table public.sites alter column presence_monitoring_enabled set default true;

create or replace function public.prosm_time_tracking_always_on()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.presence_monitoring_enabled := true;
    return new;
end;
$$;
revoke all on function public.prosm_time_tracking_always_on() from public, anon, authenticated;
drop trigger if exists sites_tracking_always_on on public.sites;
create trigger sites_tracking_always_on before insert or update of presence_monitoring_enabled on public.sites
for each row execute function public.prosm_time_tracking_always_on();

-- whoever is clocked in at a site now is followed from now on
insert into public.presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at)
select a.organization_id, a.id, a.user_id, a.site_id, 'active', now()
from public.attendance_sessions a
where a.status = 'clocked_in' and a.site_id is not null
  and not exists (select 1 from public.presence_sessions p where p.attendance_session_id = a.id)
on conflict (attendance_session_id) do nothing;

commit;
