-- 2026-11-01 (plan stage 7.5): who opened an employee's sensitive data. Attendance
-- photos are read through one path in the app, which records each opening here.
-- The owner reads the log; nobody edits it. Rollback: drop the function and table.

begin;

create table public.sensitive_access_log (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    actor_user_id uuid references public.users(id) on delete set null,
    kind text not null check (kind in ('attendance_photo', 'location_trail')),
    object_ref text,
    accessed_at timestamptz not null default now()
);

create index sensitive_access_log_org_idx on public.sensitive_access_log (organization_id, accessed_at desc);

alter table public.sensitive_access_log enable row level security;
revoke all on public.sensitive_access_log from anon;
grant select on public.sensitive_access_log to authenticated;

create policy "the owner sees who opened sensitive data" on public.sensitive_access_log
for select to authenticated
using (organization_id = public.current_prosm_time_organization_id() and public.current_prosm_time_user_is_owner());

create or replace function public.log_prosm_time_sensitive_access(p_kind text, p_object_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    v_caller uuid := public.current_prosm_time_user_id();
    v_org uuid := public.current_prosm_time_organization_id();
begin
    if v_caller is null or v_org is null then raise exception 'NO AUTHENTICATED SESSION'; end if;
    insert into sensitive_access_log (organization_id, actor_user_id, kind, object_ref)
    values (v_org, v_caller, p_kind, left(p_object_ref, 300));
end;
$function$;

revoke all on function public.log_prosm_time_sensitive_access(text, text) from public, anon;
grant execute on function public.log_prosm_time_sensitive_access(text, text) to authenticated;

commit;
