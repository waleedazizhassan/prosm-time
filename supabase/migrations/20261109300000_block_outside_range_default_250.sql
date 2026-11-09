-- 2026-11-09 (owner): "refuse a clock-in unless the person is inside the range, and make the default
-- range a circle 500 m across, adjustable in the settings."
--   * every site that checks the work area now refuses a self clock-in outside it (outside_zone_policy
--     BLOCK - the existing site rule; people exempted on their page keep their exemption), and new
--     sites start that way;
--   * a new site's range is 250 m (radius - a 500 m circle); each site's range is set on its page.
-- Existing sites keep the range they have.
-- Rollback: alter column defaults back (outside_zone_policy 'ALLOW_WITH_EXCEPTION', allowed_radius_meters
-- 100) and set outside_zone_policy back per site from the action log if needed.

begin;

alter table public.sites alter column outside_zone_policy set default 'BLOCK';
alter table public.sites alter column allowed_radius_meters set default 250;

-- the sync trigger keeps block_self_clock_in_outside_geofence in step with the policy
update public.sites set outside_zone_policy = 'BLOCK' where geofence_required and outside_zone_policy is distinct from 'BLOCK';

commit;
