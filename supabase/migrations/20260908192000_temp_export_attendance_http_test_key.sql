-- PROSM Time - temporary key to exercise export-attendance over real
-- HTTP (auth header parsing + JSON response shape), the one thing the
-- previous verification migration (20260908191000, SQL-level only)
-- didn't cover. The raw value is printed via RAISE NOTICE so it can be
-- copied from this deploy's own output; a follow-up migration deletes
-- this row once the HTTP check is done.

begin;

do $$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_raw_key text := 'ptime_httptest_' || replace(gen_random_uuid()::text, '-', '');
    v_hash text;
begin
    v_hash := encode(sha256(convert_to(v_raw_key, 'utf8')), 'hex');

    insert into api_keys (organization_id, name, key_hash, key_prefix)
    values (v_org, '__http_verification_temp__', v_hash, substring(v_raw_key, 1, 14));

    raise notice 'TEST_RAW_KEY=%', v_raw_key;
end $$;

commit;
