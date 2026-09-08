-- PROSM Time - removes the throwaway HTTP-verification key inserted
-- by 20260908192000, now that the live check against export-attendance
-- (valid key -> 200 with the correct envelope, invalid key -> 401, no
-- Authorization header -> 401) is done. Net effect on the schema after
-- this migration: none.

begin;

delete from api_keys where name = '__http_verification_temp__';

commit;
