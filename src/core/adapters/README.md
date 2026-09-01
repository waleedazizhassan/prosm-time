# Integration Adapters (WP-24 / §36)

§36 requires: "Define adapter interfaces for identity, organization,
site and entitlement providers... Design UI shells so the same core
screens can operate in standalone and integrated contexts."

This directory defines those interfaces now, as the real contract a
future PROSM Platform-native integration would implement — **not** a
second working implementation, because no such native consumption
path exists yet (§41: "PROSM Time standalone is a fully independent
application... own deployment," and native integration is its own,
later, explicitly-scoped effort). Building a second real adapter
today would mean fabricating an integration this product doesn't have.

What each interface file documents:
- The contract itself (the interface).
- Which of this repository's own real, already-shipped classes
  currently satisfies that shape (informally — none of them are
  declared `implements <Interface>` yet, since that reclassification
  is a mechanical, low-risk change best made at the moment a second
  real implementation actually needs the interface to be enforced by
  the compiler, not before).

## Files

- `IdentityProvider.ts` — resolves the current caller's identity
  (today: Supabase Auth + `users` table, via `AuthContext`).
- `OrganizationProvider.ts` — resolves organization/settings context
  (today: `OrganizationRepository`, PROSM Time's own `organizations`
  table).
- `SiteProvider.ts` — resolves site/geofence/kiosk policy (today:
  `SiteRepository`, PROSM Time's own `sites` table).
- `EntitlementProvider.ts` — resolves license/entitlement state
  (today: `LicenseRepository`, sourced from PROSM Management's
  integration contract, never duplicated as an independent authority
  per §5/§41).

## Already satisfied without new code (verified, not re-derived)

- **"Keep core attendance domain logic independent from standalone
  authentication screens"** — every attendance RPC
  (`clock_in_prosm_time_attendance` etc.) depends only on
  `current_prosm_time_user_id()` (itself resolved from `auth.uid()`),
  never on any Activation/Login component. Domain logic lives entirely
  in Postgres RPCs.
- **"Do not hard-code standalone licensing assumptions into attendance
  domain logic"** — verified via search: no attendance/timesheet/
  kiosk RPC references `license_activation_state` or licensing status
  at all. Licensing is checked exactly once, at the Dashboard's own
  License & Plan card (`LicenseRepository`), never inside a business
  RPC.
- **"Keep external integration APIs versioned"** — the PROSM
  Management integration contract
  (`prosm-management-integration` Edge Function on the Management
  side, called via `PROSM_MANAGEMENT_API_URL`/`PROSM_MANAGEMENT_API_KEY`)
  is already its own versioned API, documented in
  `ADR-049-cross-product-shared-services-boundary.md` on the PROSM
  Management side.
- **"Design UI shells so the same core screens can operate in
  standalone and integrated contexts"** — `AppShell` has zero direct
  backend imports; it only composes `Header`/`Sidebar`/`Main`, each of
  which reads exclusively through `AuthContext`'s own interface
  (`profile`, `hasPermission`), never a concrete repository directly.

## Data ownership & migration readiness

See `docs/DATA_OWNERSHIP.md` for the entity-by-entity ownership map
(§36: "Document data ownership for every entity...") and the stable-ID
migration-mapping note (§36: "Use stable domain IDs and explicit
mapping when migrating data").
