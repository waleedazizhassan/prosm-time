-- 2026-11-01 (Privacy Policy v2, section 7; plan stage 7.3): separate, dated
-- consents, per person and policy version. eu_storage is asked at first use,
-- apart from reading the policy; location and photo join it later.
-- Rollback: drop function record_prosm_time_consents; drop table data_consents.

begin;

create table public.data_consents (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    kind text not null check (kind in ('eu_storage', 'location', 'photo')),
    policy_version text not null,
    accepted_at timestamptz not null default now(),
    unique (user_id, kind, policy_version)
);

alter table public.data_consents enable row level security;
revoke all on public.data_consents from anon;
grant select on public.data_consents to authenticated;

create policy "data consents visible to subject or owner"
on public.data_consents for select to authenticated
using (
    organization_id = public.current_prosm_time_organization_id()
    and (user_id = public.current_prosm_time_user_id() or public.current_prosm_time_user_is_owner())
);

create or replace function public.record_prosm_time_consents(p_version text, p_kinds text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller_id uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_caller_id is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    if p_version is null or length(trim(p_version)) = 0 then raise exception 'VERSION IS REQUIRED'; end if;
    if p_kinds is null or cardinality(p_kinds) = 0 then raise exception 'CONSENT KIND IS REQUIRED'; end if;

    insert into data_consents (organization_id, user_id, kind, policy_version)
    select v_org, v_caller_id, kind, trim(p_version) from unnest(p_kinds) as kind
    on conflict (user_id, kind, policy_version) do nothing;

    return jsonb_build_object('success', true);
end;
$function$;

revoke all on function public.record_prosm_time_consents(text, text[]) from public, anon;
grant execute on function public.record_prosm_time_consents(text, text[]) to authenticated;

commit;
