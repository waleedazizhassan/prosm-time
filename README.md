# PROSM Time

Enterprise Time, Attendance & Workforce Presence — standalone product, formally managed by **PROSM Management** as its control plane.

**Governing reference — read this before touching anything:** [`docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md`](docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md). Coding standards / shared conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## What this is

A fully independent application: own repository (this one), own Supabase project, own database, own Storage, own Edge Functions, own deployment. It is **not** merged with, and never directly couples to, the PROSM Platform / PROSM Management repository or database. The only channel between PROSM Time and PROSM Management is a versioned, authenticated integration contract (activation, license status, entitlement checks) — see `.env.example`.

## Status

**WP-00 through WP-23 complete.** PROSM Time is a real, standalone,
independently-deployed Supabase project with its own database, Storage
and Edge Functions — Authentication/Activation, Organizations, People &
Permissions, Sites & Projects, Attendance Core, Administrative
On-Behalf Actions, Camera Evidence, GPS & Geofence, Presence
Monitoring, Exceptions & Corrections, Break & Overtime, Notifications,
Manager Console, Offline & Sync Resilience, Timesheets, Reports &
Evidence Pack, Kiosk Mode, Localization (5 languages + RTL), Theming
(Dark/Light/System), Navigation/Splash/Help, and Security Hardening
(RLS/grant audit, data-subject rights, retention) are all real,
live-HTTP-verified backend + frontend, not scaffolding. See
`docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md` §38 for the full
work-package list and each WP's own commit history for exactly what
shipped and how it was verified.

**WP-24 (PROSM Native Integration)** — the adapter layer for a future
PROSM Platform-native integration path — remains, by design: it is
explicitly deferred, standalone-first architecture (§41).

## Getting started

```bash
npm install
cp .env.example .env   # fill in PROSM Time's own Supabase URL/anon key once WP-02's project exists
npm run dev
```

```bash
npm run lint     # ESLint
npm test         # Vitest
npm run build    # tsc -b && vite build
```

## Structure

```
src/            React + TypeScript application
supabase/
  migrations/   PROSM Time's own Postgres schema (never PROSM Management's)
  functions/    PROSM Time's own Edge Functions
docs/           Master File + architecture/conventions references
```

## Deployment

The Supabase project (`wcfdhsxzeryqwpmftgay` in this environment) is
linked via the Supabase CLI (`supabase link`). Backend changes are
pushed directly to that live project — there is no separate
staging database for this product yet.

```bash
# Schema/RPC changes: add a new, timestamped migration file under
# supabase/migrations/ (never edit an already-applied one - add a new
# migration that recreates the function/policy instead), then:
npx supabase db push --linked

# Edge Function changes:
npx supabase functions deploy <function-name>

# Run this before every backend deploy - the real audit this project
# uses for RLS/grant hygiene (see WP-22):
npx supabase db advisors --linked --type security --level warn
```

Required secrets (set once via `npx supabase secrets set`, never
committed): `PROSM_MANAGEMENT_API_URL`, `PROSM_MANAGEMENT_API_KEY` (the
PROSM Management integration contract — §6/§35). `SUPABASE_SERVICE_ROLE_KEY`
is provisioned automatically for every Edge Function.

The frontend (`npm run build`) is a static Vite build with no server
of its own — it has not yet been deployed to a public host. Standing
project rule: never deploy to a public/production host without the
user's explicit go-ahead for that specific action.

**Backups**: automated database backups are a Supabase project-level
setting (dashboard → Database → Backups), not something configured via
migration — verify the plan/retention window there, not in this repo.

**Maintenance Edge Functions** (`purge-camera-evidence`,
`purge-location-samples`) are real and callable today but have no
automatic schedule wired up yet — invoke manually with the service
role key, or configure a scheduler (e.g. `pg_cron` or an external
cron hitting the function URL) when ready to automate retention.
