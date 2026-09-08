-- PROSM Time - real bug caught live by this migration's own first
-- deploy attempt: list_prosm_time_attendance_export (20260908190000)
-- failed with "column reference session_id is ambiguous" (SQLSTATE
-- 42702) - a classic PL/pgSQL pitfall, the function's own RETURNS
-- TABLE column is literally named session_id, and the has_photo_evidence
-- subquery referenced attendance_events.session_id unqualified,
-- colliding with it. Fixed here by qualifying it with a real table
-- alias. The whole migration rolled back cleanly when this fired (it's
-- one transaction), so this replaces the function correctly on retry.
--
-- Then: self-contained, self-cleaning verification of the new
-- export-attendance integration. No test account exists to exercise
-- generate_prosm_time_api_key/the Edge Function through the app itself
-- right now (the only working test login for the "Prosm" org, Lido,
-- was deleted as part of this same session's org reset) - this
-- exercises the underlying RPCs directly instead, the same way this
-- session already used RAISE NOTICE to verify the org reset's own row
-- counts. Inserts one throwaway api_keys row, proves
-- authenticate_prosm_time_api_key resolves it correctly and
-- list_prosm_time_attendance_export now runs clean against the real
-- org, then deletes the row - net effect on the schema is zero.

begin;

create or replace function public.list_prosm_time_attendance_export(
    p_organization_id uuid,
    p_since timestamptz,
    p_until timestamptz
)
returns table (
    session_id uuid,
    employee_name text,
    employee_email text,
    site_name text,
    clock_in_at timestamptz,
    clock_out_at timestamptz,
    worked_minutes numeric,
    break_minutes numeric,
    overtime_minutes numeric,
    verified boolean,
    has_photo_evidence boolean
)
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_org_threshold integer;
begin
    select daily_overtime_threshold_minutes into v_org_threshold from organization_settings where organization_id = p_organization_id;

    return query
    select
        ats.id,
        u.full_name,
        u.email,
        s.name,
        ats.clock_in_at,
        ats.clock_out_at,
        round((extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60)::numeric, 1) as worked_minutes,
        round(coalesce((
            select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60)
            from break_events be where be.attendance_session_id = ats.id
        ), 0)::numeric, 1) as break_minutes,
        round((case
            when s.overtime_start_time is not null then
                greatest(extract(epoch from ((ats.clock_out_at at time zone coalesce(s.timezone, 'UTC'))::time - s.overtime_start_time)) / 60, 0)
            else
                greatest(
                    (extract(epoch from (ats.clock_out_at - ats.clock_in_at)) / 60)
                    - coalesce((select sum(extract(epoch from (coalesce(be.ended_at, now()) - be.started_at)) / 60) from break_events be where be.attendance_session_id = ats.id), 0)
                    - coalesce(s.daily_overtime_threshold_minutes, v_org_threshold, 480),
                    0
                )
        end)::numeric, 1) as overtime_minutes,
        not exists (
            select 1 from geofence_exceptions ge
            join attendance_events ae on ae.id = ge.attendance_event_id
            where ae.session_id = ats.id
        ) as verified,
        exists (select 1 from camera_evidence ce where ce.user_id = ats.user_id and ce.attendance_event_id in (
            select ae2.id from attendance_events ae2 where ae2.session_id = ats.id
        )) as has_photo_evidence
    from attendance_sessions ats
    join users u on u.id = ats.user_id
    left join sites s on s.id = ats.site_id
    where ats.organization_id = p_organization_id
      and ats.status = 'clocked_out'
      and ats.clock_out_at between p_since and p_until
    order by ats.clock_out_at desc
    limit 500;
end;
$function$;

do $$
declare
    v_org uuid := 'cef9fc27-343d-4194-8167-033d1823b3d0';
    v_raw_key text := 'ptime_verify_' || replace(gen_random_uuid()::text, '-', '');
    v_hash text;
    v_key_id uuid;
    v_resolved_org uuid;
    v_row_count integer;
begin
    v_hash := encode(sha256(convert_to(v_raw_key, 'utf8')), 'hex');

    insert into api_keys (organization_id, name, key_hash, key_prefix)
    values (v_org, '__verification_temp__', v_hash, substring(v_raw_key, 1, 14))
    returning id into v_key_id;

    -- 1. authenticate_prosm_time_api_key must resolve this exact key
    --    to this exact organization.
    v_resolved_org := public.authenticate_prosm_time_api_key(v_raw_key);
    if v_resolved_org is null or v_resolved_org <> v_org then
        raise exception 'VERIFICATION FAILED: authenticate_prosm_time_api_key did not resolve the test key correctly (got %)', v_resolved_org;
    end if;
    raise notice 'authenticate_prosm_time_api_key: OK (resolved organization_id = %)', v_resolved_org;

    -- 2. A revoked key must resolve to nothing.
    update api_keys set revoked_at = now() where id = v_key_id;
    if public.authenticate_prosm_time_api_key(v_raw_key) is not null then
        raise exception 'VERIFICATION FAILED: a revoked key still authenticated';
    end if;
    raise notice 'revoked-key rejection: OK';
    update api_keys set revoked_at = null where id = v_key_id;

    -- 3. An invalid key must resolve to nothing.
    if public.authenticate_prosm_time_api_key('not-a-real-key') is not null then
        raise exception 'VERIFICATION FAILED: an invalid key resolved to an organization';
    end if;
    raise notice 'invalid-key rejection: OK';

    -- 4. list_prosm_time_attendance_export must run clean against the
    --    real org (this org's own attendance data was fully wiped
    --    earlier this session, so 0 rows is the CORRECT result here -
    --    this proves the query itself executes without error, not that
    --    it returns real data).
    select count(*) into v_row_count from public.list_prosm_time_attendance_export(v_org, now() - interval '90 days', now());
    raise notice 'list_prosm_time_attendance_export: OK (% rows - expected 0, this org''s attendance data was reset earlier this session)', v_row_count;

    -- Clean up - net effect on the schema after this migration is zero.
    delete from api_keys where id = v_key_id;
    raise notice 'test api_key row removed - net schema effect: none';
end $$;

commit;
