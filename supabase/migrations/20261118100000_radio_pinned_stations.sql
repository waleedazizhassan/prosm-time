-- Owner 2026-11-17: "the radio's order without a new release". The stations pinned at the top of the radio come
-- from this table (in position order), so PROSM can change them at any time; the app keeps a built-in copy for when
-- the server cannot be reached. A station with a country_code is pinned only for devices in that country (the
-- app's region, from the device time zone); without one it is pinned for everyone.
-- Read by signed-in people only (the radio plays inside the app); changed only by PROSM (migrations / SQL).
-- Rollback: drop table public.radio_pinned_stations.
begin;

create table if not exists public.radio_pinned_stations (
    position integer primary key,
    station_uuid text not null unique,
    label text not null,
    country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
    updated_at timestamptz not null default now()
);

alter table public.radio_pinned_stations enable row level security;
drop policy if exists radio_pinned_stations_read on public.radio_pinned_stations;
create policy radio_pinned_stations_read on public.radio_pinned_stations for select to authenticated using (true);
revoke all on public.radio_pinned_stations from anon, authenticated;
grant select on public.radio_pinned_stations to authenticated;

insert into public.radio_pinned_stations (position, station_uuid, label) values
    (1, 'f62577e7-24e6-416d-a262-033545e41b44', 'إذاعة القرآن الكريم من القاهرة'),
    (2, '006d7922-ffce-4c74-85ab-55ff2ed60fcc', 'Radio 9090'),
    (3, '047fcfb5-9e59-478e-9e6a-a006cc401868', 'Nogoum FM'),
    (4, 'b1d17829-6522-481b-bb5c-839c3fd44353', 'Radio Hits 88.2 Cairo'),
    (5, 'b8305209-741d-4cd4-8a6d-fac3a5f43e1b', 'Mix FM 87.8'),
    (6, '9346c66b-f42a-4a06-865d-e96dc44b1aa3', 'Sha3by FM'),
    (7, '79282606-a5a9-467b-88dc-7a63fc642f80', 'On Sport FM')
on conflict (position) do nothing;

commit;
