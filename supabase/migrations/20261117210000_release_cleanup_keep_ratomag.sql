-- Owner 2026-11-16 before release 2.4.0 ("clean the program of every test data; delete every organisation except
-- Ratomag - all of them were tests; I give you every permission"): every organisation but Ratomag is deleted with
-- all its data (the foreign keys cascade), and every sign-in account left without a person in PROSM Time goes too.
-- Ratomag (40de8634-a058-4d71-8dee-193fb94d12a3) is kept as it is. One-time data step; nothing to roll back.

begin;

do $$
declare
    v_keep constant uuid := '40de8634-a058-4d71-8dee-193fb94d12a3';
    v_orgs integer;
    v_auth integer;
begin
    if not exists (select 1 from public.organizations where id = v_keep) then
        raise notice 'Ratomag not found - nothing deleted'; -- a fresh database (tests): nothing to clean
        return;
    end if;
    delete from public.organizations where id <> v_keep;
    get diagnostics v_orgs = row_count;
    -- sign-in accounts that no longer belong to anyone in PROSM Time
    if to_regclass('auth.users') is not null then
        delete from auth.users au where not exists (select 1 from public.users u where u.auth_user_id = au.id);
        get diagnostics v_auth = row_count;
    end if;
    -- the test accounts and test sites made during the release checks (Ratomag): switched off / archived, not
    -- deleted - their records stay consistent
    update public.users set is_active = false where organization_id = v_keep and email ilike '%+qa-%';
    update public.sites set is_active = false where organization_id = v_keep and name ilike 'QA %';
    raise notice 'release cleanup: % organisations and % sign-in accounts removed', v_orgs, coalesce(v_auth, 0);
end $$;

commit;
