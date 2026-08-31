# PROSM Time

Enterprise Time, Attendance & Workforce Presence — standalone product, formally managed by **PROSM Management** as its control plane.

**Governing reference — read this before touching anything:** [`docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md`](docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md). Coding standards / shared conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## What this is

A fully independent application: own repository (this one), own Supabase project, own database, own Storage, own Edge Functions, own deployment. It is **not** merged with, and never directly couples to, the PROSM Platform / PROSM Management repository or database. The only channel between PROSM Time and PROSM Management is a versioned, authenticated integration contract (activation, license status, entitlement checks) — see `.env.example`.

## Status

**WP-00 done** (in the PROSM Management repository, not this one): PROSM Time is registered as a real product in PROSM Management's generic control plane, with real plans/entitlements and a working activation-code + integration-contract flow, verified end-to-end.

**WP-01 (this repo) — Repository & Architecture Foundation:** toolchain, structure, coding standards, shared domain conventions. In progress.

**WP-02 — Supabase Foundation:** pending an independent Supabase project (never the PROSM Management one).

Everything after that follows the Master File's §40 execution order: Authentication/Activation → Organization → People/Permissions → Sites → Attendance Core → ... See §38 for the full work-package list.

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
