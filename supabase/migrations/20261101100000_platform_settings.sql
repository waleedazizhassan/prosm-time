-- 2026-11-01 (Play release plan, stage 2): switches the Platform Manager sets
-- for the whole product. Written and read with the service role only; the
-- public-config function exposes just show_web_link and
-- apk_distribution_enabled. Rollback: drop table public.platform_settings.

begin;

create table public.platform_settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

insert into public.platform_settings (key, value) values
    ('show_web_link', 'true'::jsonb),
    -- stays true until the owner decides, after Google approves production
    ('apk_distribution_enabled', 'true'::jsonb);

commit;
