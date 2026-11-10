-- 2026-11-10 (owner): an employee clocked in with no location at all ("no location - old record or
-- permission not given") although we have fake-location protection. Since 2026-11-01 require_gps is on
-- for every new organisation, but organisations that existed before were left off - and with it off, a
-- clock-in with no reading skips the site's area check (BLOCK outside the area) and the fake-location
-- check, because there is nothing to check. The owner wants the protection whole: require_gps is now on
-- for every organisation. Clock-in, clock-out, site change and breaks then need a valid reading (online
-- or replayed from offline); a manager can still record on someone's behalf from their own device.
-- Old records are not touched.
-- Rollback: update organization_settings set require_gps = false where organization_id in (<the list
-- this migration changed>) - each is in audit_logs with action 'require_gps_turned_on'.

begin;

with changed as (
    update public.organization_settings set require_gps = true
    where require_gps is distinct from true
    returning organization_id
)
insert into public.audit_logs (organization_id, action, entity_name, reason, previous_state, new_state)
select c.organization_id, 'require_gps_turned_on', 'organization_settings',
       'owner 2026-11-10: a clock-in without any location skipped the area and fake-location checks',
       '{"require_gps": false}'::jsonb, '{"require_gps": true}'::jsonb
from changed c;

commit;
