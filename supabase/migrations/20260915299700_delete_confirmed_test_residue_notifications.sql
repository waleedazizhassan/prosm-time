-- PROSM Time - delete the 5 specific notification rows confirmed as
-- test/verification residue by id (not a broad time-window delete):
-- 2 out_of_zone_manager notifications tied to related_entity_id
-- 61702eb5-648b-43b8-b706-92faa1710020 (the 500m clock-out used by
-- this session's own item-3 verification migration
-- 20260915282000_verify_geofence_detection_now_works_for_non_owner,
-- which only cleaned the out_of_zone_employee notification and missed
-- the manager-escalation copies), and 3 timesheet_submitted
-- notifications tied to related_entity_id
-- 052e3f11-ea58-4ba8-91ed-79635f380ec1 (a timesheet from this
-- regression sweep's own testing, not a real timesheet - already
-- confirmed deleted from the timesheets table itself).
delete from notifications where id in (
    '885e0be6-de7e-4181-ac9a-0419523d4c56',
    '486d3b1e-4067-4257-8a5b-62194ccaba7d',
    '38f901b4-5a26-471d-9039-de7b85a4980a',
    'bb3ca224-80c5-4a08-b380-4bd00d789d6a',
    '7972d37a-3979-44f9-b3ee-903d259a1496'
);
