# Data Ownership & Migration Readiness (WP-24 / §36)

§36: "Document data ownership for every entity, on both the PROSM
Management side and the standalone side... Use stable domain IDs and
explicit mapping when migrating data."

## Ownership map

**PROSM Management owns** (its own database, never PROSM Time's):
licensing/entitlement records of record — products, plans,
entitlements, license records, activation codes, module grants,
`prosm_license_audit`. PROSM Time never holds a second, independently
authoritative copy of any of these (§5/§41).

**PROSM Time owns** (its own standalone Supabase project, entirely —
never PROSM Management's database): everything about *how this
organization actually runs attendance* —

| Entity | Owned by |
|---|---|
| `organizations`, `organization_settings` | PROSM Time |
| `users` / employee profiles, `roles`, `permissions`, `admin_permission_assignments` | PROSM Time |
| `sites`, `site_assignments`, `projects`, `project_assignments` | PROSM Time |
| `attendance_sessions`, `attendance_events` | PROSM Time |
| `presence_sessions`, `location_samples` | PROSM Time |
| `geofence_exceptions`, `exception_actions`, `correction_requests` | PROSM Time |
| `camera_evidence` (DB rows + Storage objects) | PROSM Time |
| `break_events`, `sos_alerts`, `device_bindings` | PROSM Time |
| `admin_on_behalf_actions`, `audit_logs` | PROSM Time |
| `notifications` | PROSM Time |
| `timesheets`, `timesheet_approvals`, `timesheet_corrections` | PROSM Time |
| `license_activation_state` | PROSM Time — but explicitly a **local cache** of PROSM Management's own record, never authoritative (refreshed via the integration contract, never independently mutated) |

One boundary case, already resolved and shipped: **email delivery**.
PROSM Time's own `invite-user` Edge Function relays through PROSM
Management's `prosm-management-integration` Edge Function (its
existing, proven Zoho Mail integration) rather than holding its own
mail-provider credentials — documented in the PROSM Management repo's
`docs/architecture/decisions/ADR-049-cross-product-shared-services-boundary.md`.
This is the one precedent for "a capability lives on one side, the
other side calls through the versioned contract rather than
duplicating it" — the same pattern §36 asks integration readiness to
generalize.

## Stable IDs & migration mapping readiness

Every PROSM Time entity's primary key is already a UUID
(`gen_random_uuid()`), generated locally and never derived from or
dependent on any PROSM Management identifier. This is already
migration-safe in the sense that matters most: nothing here would need
to be *renumbered* to move data.

What a real future migration (standalone → PROSM Platform-native)
would still need, not built because no such migration is happening
today:
- An explicit `external_id` / mapping table (e.g.
  `prosm_time_organization_id ↔ prosm_platform_organization_id`) — §36's
  own "explicit mapping when migrating data," not an implicit
  assumption that IDs from the two systems could ever collide or be
  unified silently.
- A one-time, audited backfill process for existing PROSM Time
  organizations that later adopt a PROSM Platform-native identity,
  never an automatic/implicit merge.

This mapping layer is deliberately not built now — inventing a
migration tool for a migration path that does not exist yet would be
exactly the kind of fabricated integration §41 rules out ("never build
a bespoke management subsystem when the generic one covers it," in
spirit: never build a migration tool for an integration that hasn't
been designed yet).
