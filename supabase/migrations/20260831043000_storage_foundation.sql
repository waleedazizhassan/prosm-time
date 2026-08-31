-- PROSM Time Implementation Master File V3.0, WP-02 (§38: "Supabase
-- Foundation... storage... foundation") + §16/§24: "Private object
-- storage for camera evidence... access-controlled (signed/authorized
-- access)."
--
-- Bucket creation only - deliberately no storage.objects RLS policies
-- yet. Real access-control policies need to scope by organization_id/
-- attendance_event ownership, which doesn't exist until WP-03
-- (organizations/users) and WP-08 (camera evidence linkage) land - a
-- policy written against tables that don't exist yet would be exactly
-- the kind of speculative, unverified SQL the Season's "no
-- placeholders, no unverified completion claims" rule warns against.
-- The bucket is marked NOT public in the meantime, so it is closed by
-- default rather than silently open.

begin;

insert into storage.buckets (id, name, public)
values ('camera-evidence', 'camera-evidence', false)
on conflict (id) do nothing;

commit;
