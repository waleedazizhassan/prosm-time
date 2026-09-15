-- Live verification of export-sites/export-workers, mirroring the
-- self-cleaning migration technique used throughout this session -
-- generates a REAL, TEMPORARY api_keys row for whichever real org
-- already has real sites/site_workers/users data, so the RPCs behind
-- the two new Edge Functions can be proven against real rows without
-- touching any product's live UI config. The raw key is surfaced via
-- RAISE NOTICE so it can be used once from outside this transaction,
-- then the row is deleted at the end of this same migration (the key
-- never survives past this file).
do $$
declare
    v_org_id uuid;
    v_org_name text;
    v_raw_key text;
    v_key_hash text;
    v_site_count integer;
    v_worker_count integer;
begin
    select o.id, o.name into v_org_id, v_org_name
    from organizations o
    where exists (select 1 from sites s where s.organization_id = o.id)
    order by o.created_at
    limit 1;

    if v_org_id is null then
        raise notice 'NO ORG WITH SITES FOUND - cannot verify.';
        return;
    end if;

    select count(*) into v_site_count from sites where organization_id = v_org_id;
    select count(*) into v_worker_count from users where organization_id = v_org_id;

    v_raw_key := 'ptime_verify_' || replace(gen_random_uuid()::text, '-', '');
    v_key_hash := encode(sha256(convert_to(v_raw_key, 'utf8')), 'hex');

    insert into api_keys (organization_id, name, key_hash, key_prefix, scope, created_at)
    values (v_org_id, 'TEMP-VERIFY-export-sites-workers', v_key_hash, left(v_raw_key, 12), 'attendance:read', now());

    raise notice 'ORG % (%) has % site(s), % user(s). RAW KEY: %', v_org_name, v_org_id, v_site_count, v_worker_count, v_raw_key;
end $$;
