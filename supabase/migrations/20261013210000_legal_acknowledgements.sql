-- Privacy Policy and Terms of Use (owner 2026-10-13): each signed-in person
-- reads and acknowledges the current version once; the Owner also accepts
-- the Terms on behalf of the organisation. A record of who acknowledged
-- which version and when - kept as evidence, written only through
-- acknowledge_prosm_time_legal().

begin;

create table if not exists public.legal_acknowledgements (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    version text not null,
    accepted_for_organization boolean not null default false,
    acknowledged_at timestamptz not null default now(),
    unique (user_id, version)
);

create index if not exists legal_acknowledgements_organization_id_idx on public.legal_acknowledgements(organization_id);

alter table public.legal_acknowledgements enable row level security;

-- The person themself; the Owner sees the whole organisation's.
drop policy if exists "legal acknowledgements visible to subject or owner" on public.legal_acknowledgements;
create policy "legal acknowledgements visible to subject or owner"
on public.legal_acknowledgements for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id = public.current_prosm_time_user_id() or public.current_prosm_time_user_is_owner())
);

revoke all on public.legal_acknowledgements from anon;
grant select on public.legal_acknowledgements to authenticated;

create or replace function public.acknowledge_prosm_time_legal(p_version text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid;
    v_org uuid;
begin
    v_caller_id := public.current_prosm_time_user_id();
    v_org := public.current_prosm_time_organization_id();
    if v_caller_id is null or v_org is null then
        raise exception 'NO AUTHENTICATED SESSION';
    end if;
    if p_version is null or length(trim(p_version)) = 0 then
        raise exception 'VERSION IS REQUIRED';
    end if;

    insert into legal_acknowledgements (organization_id, user_id, version, accepted_for_organization)
    values (v_org, v_caller_id, trim(p_version), public.current_prosm_time_user_is_owner())
    on conflict (user_id, version) do nothing;

    return jsonb_build_object('success', true);
end;
$function$;

revoke execute on function public.acknowledge_prosm_time_legal(text) from public, anon;
grant execute on function public.acknowledge_prosm_time_legal(text) to authenticated, service_role;

commit;
