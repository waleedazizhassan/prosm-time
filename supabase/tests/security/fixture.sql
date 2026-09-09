-- Minimal stand-in for the parts of the PROSM Time schema the password
-- reset path touches, so the hardening migration can be exercised for real.
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if; end $$;

create table public.users (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null default gen_random_uuid(),
    auth_user_id uuid not null default gen_random_uuid(),
    email text not null unique,
    full_name text not null,
    status text not null default 'active'
);

create table public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid,
    subject_user_id uuid,
    action text,
    entity_name text,
    entity_id uuid,
    description text,
    created_at timestamptz not null default now()
);

create table public.password_reset_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    verification_code text not null,
    status text not null default 'PENDING' check (status in ('PENDING', 'CONSUMED', 'EXPIRED')),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    consumed_at timestamptz
);
alter table public.password_reset_requests enable row level security;
revoke all on public.password_reset_requests from anon, authenticated;

insert into public.users (email, full_name) values ('owner@example.com', 'Real Owner');
-- A pre-existing plaintext PENDING code, to prove the migration retires it.
insert into public.password_reset_requests (user_id, verification_code, expires_at)
select id, '111111', now() + interval '30 minutes' from public.users where email = 'owner@example.com';
