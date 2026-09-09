-- Extra stand-in schema for the License Enforcement & Installation Identity
-- assertions. Loaded after fixture.sql, before the enforcement migration.

create table public.organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null
);

create table public.license_activation_state (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null unique references public.organizations(id) on delete cascade,
    license_number text not null unique,
    status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
    max_users integer,
    max_devices integer,
    expires_at timestamptz,
    last_verified_at timestamptz not null default now()
);

-- Licensed organization + its owner.
insert into public.organizations (id, name) values
    ('11111111-1111-1111-1111-111111111111', 'Licensed Org'),
    ('22222222-2222-2222-2222-222222222222', 'Unlicensed Org'),
    ('33333333-3333-3333-3333-333333333333', 'Suspended Org'),
    ('44444444-4444-4444-4444-444444444444', 'Expired Org');

insert into public.license_activation_state (organization_id, license_number, status, expires_at) values
    ('11111111-1111-1111-1111-111111111111', 'LIC-ACTIVE', 'ACTIVE', now() + interval '365 days'),
    ('33333333-3333-3333-3333-333333333333', 'LIC-SUSPENDED', 'SUSPENDED', now() + interval '365 days'),
    ('44444444-4444-4444-4444-444444444444', 'LIC-EXPIRED', 'EXPIRED', now() - interval '1 day');

insert into public.users (organization_id, auth_user_id, email, full_name) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'licensed@example.com', 'Licensed User'),
    ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 'unlicensed@example.com', 'Unlicensed User'),
    ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 'suspended@example.com', 'Suspended User'),
    ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-0000-0000-0000-000000000004', 'expired@example.com', 'Expired User');
