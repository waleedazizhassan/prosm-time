# PROSM Time — Coding Standards & Shared Domain Conventions (WP-01)

Governing reference: [`PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md`](./PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md). This document only records the *how* (repo conventions); the master file is the *what*.

## Stack

React 19 + Vite 7 + TypeScript, Supabase (`@supabase/supabase-js`), react-router-dom, react-i18next. Vitest + Testing Library for tests. ESLint (flat config, typescript-eslint) for lint.

## Independence from PROSM Platform / PROSM Management

This repository, its Supabase project, and its deployment are **completely independent** from the PROSM Platform / PROSM Management repository and Supabase project. No shared tables, no shared auth, no shared connection strings, no shared credentials — ever (Master File §6, §7, §43.5, §43.6). The only channel between the two systems is the versioned integration contract (`prosm-management-integration` Edge Function on the PROSM Management side) — see `.env.example` for how PROSM Time's own backend authenticates to it.

## Repository pattern

Every table/RPC gets a thin repository class under `src/core/repositories/`, one file per aggregate, mirroring the PROSM Platform convention exactly:

```ts
class SomeRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  createSuccess(data = null) {
    return { success: true, message: null, data };
  }

  createError(message, data = null) {
    return { success: false, message, data };
  }

  async listSomething() {
    try {
      const { data, error } = await this.client.from("some_table").select("*");
      if (error) return this.createError(error.message);
      return this.createSuccess(data ?? []);
    } catch (error) {
      return this.createError(error instanceof Error ? error.message : "Service unavailable.");
    }
  }
}

export default new SomeRepository();
```

Callers always check `result.success` — never let a thrown exception cross a repository boundary uncaught. This is the same shape used throughout PROSM Platform's `src/core/repositories/` and is what makes a repository written for one product read identically in the other.

## Database access — `DatabaseManager`

Repositories never import the Supabase client directly. They call `DatabaseManager.getClient()` (`src/core/database/DatabaseManager.ts`), which lazily initializes the singleton from `src/core/api/supabaseClient.ts`. Same layering as PROSM Platform.

## Server-side enforcement (Master File §9, §15, §35)

The client **reflects** permission/business state; it never **enforces** it. Every sensitive write (Clock In/Out, administrative on-behalf actions, exceptions, corrections, SOS) goes through a Supabase Edge Function or a `SECURITY DEFINER` Postgres RPC — never a direct `insert`/`update` from the frontend against a business-critical table. Geofence validation, idempotency, and authority checks live server-side, always.

## i18n (Master File §27)

One namespace per screen/domain area under `src/i18n/locales/<lang>/<namespace>.json`, all five languages (`en`, `ar`, `fr`, `de`, `it`) touched together — never a namespace with English-only content. No hard-coded user-facing strings in components. `src/i18n/direction.ts` is the single place that reads/writes `document.documentElement.dir` for RTL.

## Theming (Master File §28–29)

Dark mode is the default. Until the official PROSM logo is supplied (§29, §33), any design tokens are clearly labeled neutral placeholders — never a guessed brand palette. No component may claim a "final" branded look before the real logo lands.

## Audit (Master File §26)

Every sensitive administrative action writes an audit record with Actor, Subject (when different from Actor — see §10's on-behalf distinction), Action, Timestamp, Reason (where applicable), Previous/New state, and the relevant entity/entity ID. Modeled after PROSM Management's own `prosm_license_audit`/`audit_logs` shape.

## Testing & gate

Before any commit: `npm run lint` (clean), `npm test` (passing), `npm run build` (clean) — in that order, matching PROSM Platform's own standing workflow rule.
