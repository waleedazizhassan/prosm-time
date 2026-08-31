# PROSM Time — Implementation Master File
## Version 3.0 — Management, UX & Platform Integration Hardening

**Standalone Product → Managed PROSM Product → Future Native PROSM Platform Module**

> Single execution baseline for PROSM Time. This version supersedes V2.0. It preserves every V2 audit addition (offline resilience, kiosk mode, break/overtime engine, correction requests, SOS, device binding, site timezone, anomaly flag) and layers in V3's requirements: PROSM Management must formally manage PROSM Time as a product **before** the standalone application is built, plus granular authorization, admin-on-behalf actions, localization, theming, real visual identity, navigation, splash/help surfaces, and owner-supplied assets.
> Written to be handed directly to **Claude Code** as the build brief.

**Core technology baseline:** React + Vite + TypeScript, Supabase, PostgreSQL, Supabase Edge Functions, private Storage, Row-Level Security (RLS), UTC timestamps (site-local display).

---

## 0. Critical Execution Order (Read First)

Implementation happens in **two phases, in this order.** Do not skip or reorder.

```
Phase 0 — PROSM Management Platform
   └── Register PROSM Time as a managed product
   └── Define Plans / Editions
   └── Define Entitlements
   └── Build Activation & License Issuance
        ↓
Phase 1 — Standalone PROSM Time Application
   └── Own Supabase project / own repo
   └── Consumes activation/entitlements from PROSM Management
       via a controlled, authenticated API contract only
```

**Claude Code must NOT treat PROSM Time as an isolated application with its own independent licensing authority.** PROSM Management is the control plane and must be extended *first* so that the standalone application has something real to activate against.

This does **not** mean the standalone application's database, auth, or runtime is merged with PROSM Platform. It means:
- PROSM Management's existing codebase gains a new "PROSM Time" product-management section (Phase 0).
- The standalone PROSM Time app (Phase 1) talks to PROSM Management **only** through a versioned, authenticated integration contract/API — never direct database coupling, never shared tables, never shared auth secrets.

---

## 1. Product Identity & Vision

**Product:** PROSM Time — Enterprise Time, Attendance & Workforce Presence.

**Vision:** A professional attendance and workforce-presence product that stands on its own as a SaaS/application, formally managed as a PROSM product from day one, and architecturally ready to become a native PROSM Platform module later.

- Simple employee Clock In / Clock Out.
- Camera capture as attendance evidence; no face recognition requirement in V1.
- GPS validation at attendance events.
- Worksites and projects with configurable geofencing.
- Presence monitoring during an active work session only.
- Out-of-zone exception workflow with employee reason and manager notification/review.
- Notifications for expected Clock In and Clock Out times.
- Manager/administrator management console with granular, role-based authorization.
- Monthly timesheets with review, approval, locking, PDF/print and export capability.
- Full localization, theming, and PROSM visual identity.
- Auditability, privacy, security and production readiness from the beginning.

## 2. Competitive Research Baseline

Study the strongest patterns used by paid workforce/time-management products — attendance, GPS/geofencing, schedules, timesheets, notifications, approvals, manager dashboards, mobile/kiosk experiences — without copying implementation or UI. Identify mature patterns, then add a distinct PROSM operating model.

Research dimensions: attendance/shift lifecycle, GPS/geofence behavior and accuracy handling, mobile/kiosk attendance UX, timesheet review and approval, exception and absence workflows, notifications and escalation, multi-site workforce management, reporting/export, licensing/entitlements/administration, privacy/retention/audit/anti-abuse controls.

## 3. PROSM Differentiation — The PROSM Touch

- **Presence Trust Score** — an explainable confidence indicator based on configured evidence (GPS validity, camera evidence, device/session integrity, approved exceptions). Never an opaque employee-judgment score.
- **Presence Exception Workflow** — leaving a configured work zone becomes a controlled business event: detect → notify → employee provides reason → manager reviews/acts → audit record.
- **Safety Roll Call** — a site-oriented view showing expected/active/left/unconfirmed presence for operational or emergency situations.
- **Monthly Evidence Pack** — a formal monthly package containing approved attendance records, relevant exceptions, evidence references, approvals and summary information.
- **Project-aware attendance** — attendance can be associated with a site and, where configured, a project/work assignment.
- **Integration-ready core** — the same capability operates standalone today and can later consume PROSM identity, organization, site, governance and entitlement services.

### 3.1 Additional Differentiators

- **Anomaly Detection Flag** — explainable heuristics (not black-box ML) flagging unusual patterns for review: sudden distant Clock In, repeated identical evidence images, improbable travel speed. Surfaces on the Presence Trust Score, never an automatic penalty.
- **Emergency / SOS Action** — always-reachable during an active Presence Session; raises a high-priority alert to the site's Safety Roll Call and responsible manager(s). Low-friction with a confirm step; never throttled or batched.
- **Shift Handover Note** — optional short free-text note at Clock Out, visible to the next scheduled employee at that site/shift.
- **Environmental/Context Tag** (optional, per-site policy) — lightweight tag at Clock In for field/industrial sites (e.g., weather/site condition) for safety reporting. Off by default.

## 4. Product Editions & Entitlements

One product core. Availability controlled through server-side entitlements/feature flags — never separate codebases per edition. Editions are **defined and managed inside PROSM Management** (§6), not hard-coded in the standalone app.

| Edition | Illustrative scope |
|---|---|
| Free / Starter | Core Clock In/Out, camera evidence, basic GPS validation, basic timesheet/reporting limits |
| Professional | Geofencing, presence sessions, exception workflow, notifications, richer reports, monthly evidence pack |
| Enterprise | Advanced multi-site controls, API/webhooks, advanced governance, larger operational limits, SOS/Safety Roll Call, anomaly detection |

**Rule:** commercial edition boundaries are entitlement decisions, not architectural forks.

## 5. Activation & Licensing Model

- PROSM Management is the **single, central** licensing/issuance authority — never duplicated inside the standalone app.
- Standalone mode: the customer activates PROSM Time using an Activation Code **issued by PROSM Management** (§6).
- Activation code identifies product, edition/entitlements, validity and applicable limits.
- Activation must be verified **server-side** against PROSM Management's API; never trust a client-only activation flag, and never let the standalone app self-issue or self-validate licenses.
- Activation state and entitlement state are auditable on both sides (PROSM Management's record of issuance, and the standalone app's record of activation).
- License renewal, suspension, expiration and revocation are lifecycle states, initiated from PROSM Management and reflected in the standalone app via the integration contract.
- Activation secrets must never be stored or exposed as plain reusable credentials.

**Integrated PROSM mode:** the activation-code flow is not used as the module activation mechanism. PROSM Management grants module entitlements/authority inside the PROSM Platform directly instead.

## 6. PROSM Management — Generic Product/Module Control Plane (Build This First)

**Architectural correction from earlier drafts:** PROSM Management already exists as the platform's control page — it issues activation codes and grants module permissions today. That existing control plane must be **generalized**, not duplicated. PROSM Time is the **first product registered against it**, not the reason it exists. Any future PROSM application (or any future native platform module) registers into the exact same generic system — no new management subsystem is ever built per product again.

**If the existing PROSM Management control page is currently hard-coded around specific modules/products, this work package's job is to refactor it into a generic, product-agnostic registry first — then register PROSM Time as its first entry.**

Required capabilities (generic — apply to any current or future product):
- Register a product/module (name, type — `standalone_application` or `native_platform_module` — description, status).
- Define and manage plans/editions **per product**.
- Define entitlements/feature flags **per plan**.
- Create customer/company licensing records **per product, per organization**.
- Issue Activation Codes for standalone installations of any registered product.
- Activate, suspend, renew and revoke licenses for any product.
- View license status and lifecycle across all products from one place.
- Manage plan limits and enabled features per product.
- Track activation history across all products.
- Track license and product-registration actions through the audit system.
- Grant/revoke module entitlements/authority for products running natively inside PROSM Platform.
- Prepare any registered standalone product for future native integration into PROSM Platform.

**The Management Platform must NOT directly manipulate any standalone application's database.** Communication between PROSM Management and any standalone product (PROSM Time included) must use a controlled, authenticated integration contract/API — in both directions. The same contract shape (versioned activation/entitlement API) is reused for every product; PROSM Time must not get a bespoke integration contract that a future product can't also use.

## 7. Standalone vs PROSM Platform Mode

**A. Standalone Application**
- Its own Supabase project.
- Its own PostgreSQL database.
- Its own Edge Functions.
- Its own Storage.
- Its own application deployment (own repository).
- Its own customer organization data.
- License issued and controlled by PROSM Management (§5, §6); Activation Code required.

**B. Native PROSM Platform Module** (future)
- Becomes a managed PROSM module.
- PROSM Management controls its entitlement directly.
- Standalone Activation Code flow is **not** used for internal module enablement.
- Existing PROSM identity, organization, governance and authorization infrastructure is reused per the final integration contract.

Integration must be controlled and deliberate — **never an uncontrolled database merge.** Reusable application/domain code may be integrated where appropriate, while database ownership and migrations are handled explicitly. See §36 (Integration Readiness Requirements).

## 8. Multi-Client Application Architecture

PROSM Time must support multiple clients against the same backend:
- Web Administration Application.
- Mobile Application.
- Manager/Supervisor Mobile Experience.
- Kiosk Mode (§13.1).

All clients use the same backend/domain rules. Business logic must **not** be duplicated separately between Web and Mobile. Critical authorization and business rules are always enforced server-side.

## 9. Access & Authorization Model

The **Company Owner / Primary Administrator** has the highest administrative authority within the organization. The Owner can create additional administrators and delegate granular permissions. **An administrator does not automatically receive full Owner authority.**

Permissions must be granular and configurable, e.g.:
- View employees / Create employees / Edit employees / Manage employee accounts.
- View attendance / Create Clock In on behalf of an employee / Create Clock Out on behalf of an employee.
- Correct attendance.
- Manage GPS settings / Manage sites / Manage projects / Manage schedules.
- View reports / Generate PDF reports / Generate Timesheets / Approve Timesheets.
- Manage exceptions / Manage notifications / Manage settings.
- Manage administrators / Assign or revoke permissions.

The authorization model must support these action types per resource: **VIEW, CREATE, EDIT, DELETE, EXECUTE, APPROVE, EXPORT, ADMINISTER.**

Role/permission checks are enforced **server-side** (RLS + Edge Functions) — the client only reflects, never enforces, permission state.

## 10. Administrative Clock In / Clock Out (On Behalf Of)

An authorized administrator may perform Clock In or Clock Out on behalf of an employee when business circumstances require it (e.g., employee physically present but unable to perform the action themselves).

**The system must record:**
- Employee affected.
- Administrator who performed the action.
- Date/time.
- Location where applicable.
- Device/session information where applicable.
- Reason.
- Original attendance state.
- Resulting attendance state.
- Audit event ID.

**The employee must never appear as the person who performed the administrative action.** The audit trail clearly distinguishes:
- **ACTOR** = the administrator.
- **SUBJECT** = the employee.

This is a distinct, permissioned action (`Create Clock In on behalf of an employee` / `Create Clock Out on behalf of an employee` in §9) — not a variant of the employee's own Clock In/Out flow, and it must never be confused with, or silently merged into, the employee's self-reported attendance history.

## 11. Organization & Initial Setup

- Activation/registration (against PROSM Management, §5–6).
- Organization/company profile.
- Primary administrator creation.
- Initial worksite creation.
- Optional initial project creation.
- Working schedules and default attendance policy.
- Notification policy.
- Privacy and evidence-retention settings.
- Invite/add employees.
- Kiosk mode toggle per site (§13.1).
- Default theme, default language (§27–28).
- Verify configuration before production use.

## 12. Users, Employees & Roles

- Separate authentication identity from employee/workforce profile.
- Owner/Primary Administrator, Manager/Site Manager, Supervisor/Team Lead, Employee, Read-only/reporting role.
- Granular permission assignment per administrator, per §9 — roles are a convenient bundle, not a hard ceiling; individual permissions can be added/removed per admin.
- Employees receive invitations or controlled onboarding rather than administrators handling employee passwords.
- Authorization enforced server-side with RLS and Edge Functions.
- **Device binding:** each employee's account can be linked to one or more approved devices for attendance actions. Unrecognized device attempting Clock In is blocked, requires re-verification, or flagged for review, per organization policy.

## 13. Sites & Projects

A worksite is a first-class operational entity (example: Factory Z — Al Agamy, Alexandria). The manager defines the address for display and a precise map location for actual validation.

- Site name, display address, latitude/longitude, allowed radius.
- GPS accuracy/tolerance policy — configurable **per site**, not just globally.
- Time zone (site-local display; storage remains UTC).
- Active/inactive state.
- Assigned employees, assigned managers.
- Optional project association.
- Site policy: attendance allowed, geofence required, camera required, kiosk mode, environmental tag enabled, etc.
- Map-based configuration and a test/verify function.

**Critical rule:** the written address is informational. GPS coordinates and configured radius are the source of truth for geofence validation.

### 13.1 Kiosk Mode

For sites (factories, warehouses, construction sites) that need a shared device at the entrance rather than personal phones:
- Per-site policy: `personal_device_only`, `kiosk_only`, or `both_allowed`.
- Kiosk mode: a locked-down screen at a fixed device where each employee identifies themselves (PIN, badge scan, or account selection) then completes Clock In/Out with camera evidence captured by the kiosk device.
- Kiosk device GPS is fixed/known (the site's own coordinates).
- Kiosk sessions still produce individual, auditable attendance events per employee — never a shared/anonymous log.

## 14. Project Selection

Where enabled by organizational policy, an employee may select the project they are working on during attendance.

The system must support the relationship: **Site → Project → Employee → Assignment → Attendance event.**

Project selection must respect employee/project authorization. Employees must **not** be able to select projects to which they are not assigned.

## 15. GPS & Geofencing Architecture

- Use browser/device geolocation APIs for the initial web/PWA implementation.
- Request location permission transparently and only when required.
- Clock In captures a location sample and accuracy metadata; Clock Out captures a final location sample when policy requires it.
- During an active Presence Session, the application can receive periodic location updates subject to platform/browser capabilities and permissions.
- After Clock Out, active presence tracking stops.
- Geofence calculation is performed **server-side** from trusted event data; never rely only on client-side distance checks.
- Store latitude/longitude, accuracy, timestamp, source and validation result per retention policy.
- Use a configurable, **per-site** grace/accuracy policy to reduce false alarms from GPS drift.

**Distance model:** geodesic/haversine-style calculation between the captured coordinate and the site's configured center, compared with the site's allowed radius plus policy tolerance.

## 16. Attendance Evidence (Camera)

Camera evidence supports attendance without requiring face recognition in V1.

- May be required during Clock In, Clock Out, or other configured attendance events.
- Open camera capture from supported device/browser; associate evidence with the attendance event.
- Evidence must be: privately stored, access-controlled (signed/authorized access), linked to the attendance event, auditable, subject to retention/deletion policy.
- Do not treat an image as biometric identification in V1. Future face recognition/liveness, if ever introduced, is a separate security/privacy architecture decision.

## 17. Attendance Lifecycle

`Scheduled → Clock-In Pending → Clocked-In → Presence Active → Exception (if any) → Clocked-Out → Under Review → Approved → Locked`

- **Scheduled** / **Clock-In Pending** / **Clocked-In** / **Presence Active** / **Exception** / **Clocked-Out** / **Under Review** / **Approved** / **Locked** — as defined in prior versions; locked periods are immutable except through controlled correction workflow.

### 17.1 Break / Lunch Lifecycle

`Presence Active → Break Started → Break Ended → Presence Active (resumed)`
- Break Start/End are their own lightweight, server-timestamped attendance events.
- Policy controls: paid vs unpaid, max duration, whether GPS/camera required (usually not).
- Exceeding max break duration notifies the employee and, optionally, the manager — not a hard block.

### 17.2 Overtime Policy Engine

- Organization- and site-level rules: daily/weekly threshold, pre-approval requirement or automatic calculation.
- Computed server-side from approved attendance events, never self-reported.
- Appears as a distinct, clearly labeled line in the timesheet (§22), never folded silently into regular hours.

### 17.3 Employee Self-Correction Request

- Employee submits a correction request against their own record (e.g., forgot to Clock Out) with reason and proposed correct time — never silently changes the record.
- Enters the same manager review/approval queue as system-detected exceptions (§19), fully audited.
- Original recorded event (or its absence) is never overwritten — the correction is a new audited record layered on top.

## 18. Presence Session Lifecycle

- Created at successful Clock In when presence monitoring is enabled.
- Active while the employee is within an authorized work session; location samples collected per policy and platform capability.
- Out-of-zone detection creates a Presence Exception (§19).
- Employee is notified and can provide a reason; manager receives an alert per escalation policy.
- SOS/Emergency action (§3.1) is reachable at all times during an active session.
- Session ends at Clock Out or controlled termination; **no active presence tracking after Clock Out.**

## 19. Out-of-Zone Exception Workflow

1. Detect coordinate outside permitted geofence.
2. Apply GPS accuracy/grace rules before declaring a confirmed violation.
3. Notify employee: "You are outside your assigned work area."
4. Allow employee to enter a reason (purchasing food, restroom, work assignment, emergency, other approved category).
5. Record reason and timestamp — never silently modify the original GPS event.
6. Notify the responsible manager/team lead per policy.
7. Manager can approve, reject, acknowledge or request clarification.
8. Write every action to audit history (§26).

## 20. Notifications

- Upcoming/late Clock In reminder, upcoming Clock Out reminder, missing Clock Out alert.
- Out-of-zone alert to employee; out-of-zone notification to manager.
- Pending exception review; timesheet approval pending.
- Break duration exceeded (§17.1); correction request submitted/reviewed (§17.3).
- **SOS/Emergency alert — always highest priority, never throttled or grouped.**
- License/plan lifecycle notifications where applicable (sourced from PROSM Management, §6).

Notification delivery is configurable by organization/site/role and must avoid excessive repeated alerts. SOS is the sole exception.

## 21. Manager / Administration Console

- Dashboard: today's attendance and active presence.
- Employees and assignments; sites and geofences; projects; schedules/shifts.
- Exceptions and approvals (including employee self-correction requests).
- Attendance corrections through controlled workflow, including administrative Clock In/Out (§10).
- Notifications and escalation settings.
- Timesheets; reports and evidence packs; audit log.
- Administrator and permission management (§9) — assign/revoke granular permissions.
- License/entitlement status as reflected from PROSM Management.
- **Mobile-usable approval flow:** timesheet and exception approvals must work well on a manager's phone — field/site managers rarely sit at a desk.

## 22. Timesheet & Monthly Evidence Pack

- Employee reviews their period; manager reviews and approves; approved period becomes locked.
- Correction requires an explicit correction workflow and audit trail.
- Monthly Timesheet includes: employee info, organization, site, project where applicable, dates, Clock In/Out, worked duration, breaks, overtime (distinct line item), exceptions, corrections, approval status, approver, approval date, lock status.
- Printable and exportable as PDF; also exportable as spreadsheet where required.
- Authorized management users can generate a monthly Timesheet for any employee within their site scope.
- Monthly Evidence Pack can include approved attendance records, GPS validation summaries, camera evidence references, exception reasons and approvals subject to privacy/retention policy.

## 23. Governance Model

- Administrative authority (configuration) vs business authority (approvals) are distinct — see §9.
- Site scope: managers act only within authorized sites.
- Role/permission checks are server-side.
- Segregation of duties where approval and correction powers could create conflicts.
- Every sensitive action is auditable (§26).
- Policy decisions are explicit and configurable rather than hidden in UI code.

## 24. Security & Privacy Baseline

- Shared-schema multi-tenant model inside the standalone application with `organization_id` isolation.
- RLS on tenant-owned tables; server-side authorization for sensitive operations.
- Private object storage for camera evidence; signed/authorized evidence access.
- UTC timestamps for storage; site-local timezone for display.
- Minimal location collection: only what the configured attendance/presence feature needs; presence tracking stops at Clock Out.
- Configurable retention/deletion for location and camera evidence.
- Rate limiting and abuse controls for attendance endpoints; protection against duplicate/replay submissions.
- **Data subject rights:** admin can export or delete an individual employee's personal attendance data on request, subject to legal/retention holds.

## 25. Offline & Connectivity Resilience

- Clock In/Out actions attempted while offline are queued locally on the device (with captured GPS sample, camera evidence, and a client-generated idempotency key).
- On reconnect, queued events sync to the server. Server time at sync determines authoritative processing order, but the original client-captured timestamp is preserved and stored alongside it.
- Queued/offline events are visibly marked "pending sync" until confirmed.
- Duplicate submission protection holds even when the same action is queued and retried multiple times offline.
- Kiosk-mode devices (§13.1) also handle brief connectivity loss gracefully with local queuing.

## 26. Audit Requirements

Every sensitive administrative operation must be auditable. At minimum, each audit record includes:
- **Actor**, **Subject**, **Action**, **Timestamp**, **Reason** (where applicable).
- **Previous state**, **New state**.
- **Relevant entity** and **relevant entity ID**.
- **Location** (where applicable), **device/session context** (where applicable).

Examples requiring an audit record: administrative Clock In, administrative Clock Out, attendance correction, GPS policy modification, employee account modification, permission assignment, permission revocation, timesheet approval, timesheet correction, timesheet locking, license activation, license suspension, license renewal, license revocation.

## 27. Language Support

PROSM Time must support: **Arabic, English, French, German, Italian.**

- The application is fully internationalized — do not hard-code user-facing strings inside business logic or components where localization is required.
- The official information email (`info@prosm.com`) remains unchanged across all languages.
- RTL layout must be correctly supported for Arabic.

## 28. Theme / Appearance

- **Dark Mode is the default application appearance.**
- The user can switch between Dark, Light, and System/Default device preference where supported.
- Behavior is consistent across Web and Mobile.

## 29. PROSM Visual Identity

The application visual identity must be inspired by the **official PROSM logo supplied by the Product Owner.**

- The supplied logo is the visual reference for: Primary Blue, supporting Blue shades, supporting Green, Warning/Error Red, dark surfaces, light surfaces, icons and visual accents.
- **Do not guess the logo colors.** The supplied logo image must be inspected and the actual visual palette extracted/approximated accurately before finalizing design tokens.
- **If the logo has not yet been supplied, Claude Code must stop and explicitly request it before finalizing any design tokens or "final" branded screens** — build with clearly labeled neutral placeholders in the meantime (see §33).

**Color semantics:**
| Color | Meaning |
|---|---|
| Blue | Primary actions, navigation, interactive controls, active states |
| Green | Success, valid presence, approved states |
| Red | Error, rejection, critical danger, SOS/emergency — **never** a general brand color |

The final design token system must be shared between Web and Mobile.

## 30. Navigation

Navigation must be explicitly designed and implemented, appropriate to the user's role, and must respect authorization — users never see administrative navigation items for which they have no permission.

Core areas may include: Home/Dashboard, Attendance, Presence, Employees, Sites, Projects, Schedules, Exceptions, Notifications, Timesheets, Reports, Administration, Settings, Help. Exact structure may adapt by role and client type (§8).

## 31. Splash Screen

- Presentation/startup surface only — **must not contain business logic.**
- Uses PROSM Time branding and the approved visual identity (§29).
- Footer contains the official information contact: **info@prosm.com** — visible, clickable where supported, consistent across all languages.
- Additional product/help information may be shown without cluttering the startup experience.

## 32. Help & Support

A dedicated Help area must exist, providing: product help, basic usage guidance, FAQ where implemented, support contact, information contact.

- Official information contact: **info@prosm.com**.
- A dedicated support email may be added later when officially provided.
- **Do not invent a support email address.**

## 33. Owner-Provided Visual Assets (Asset Policy)

> **Claude Code must never invent, generate, or hallucinate** a logo, brand mark, icon set claiming to be "PROSM's," or product photography.

The Product Owner may provide assets for: Splash Screen, Login/Welcome, empty states, Help, product presentation, and other visual surfaces (including the official logo, §29).

Claude Code must:
- Inspect supplied assets before using them.
- Determine whether an asset is appropriate for the relevant screen.
- Use the asset when it improves the product experience.
- Preserve supplied branding exactly — no reinterpretation.
- **Not** invent replacement assets when an appropriate supplied asset exists.
- **Not** fetch random external images simply to fill empty UI areas.

When no asset has been supplied yet for a screen that needs one, use a clearly labeled placeholder (e.g., "LOGO PLACEHOLDER — awaiting asset from PROSM") and explicitly ask the user to upload the real asset. Generic functional UI icons (from a standard icon library — clock, camera, map pin) are not brand assets and are fine to use directly.

## 34. Database Architecture — Domain Model

**PROSM Management side (Phase 0 — generic control plane, product-agnostic):**
- `prosm_products` (any product/module — Time is one row, not a schema unto itself)
- `prosm_product_plans` / `prosm_product_editions` (keyed by `product_id`)
- `prosm_entitlements` (keyed by `plan_id`)
- `prosm_license_records` (keyed by `product_id` + customer organization)
- `prosm_activation_codes` (keyed by `product_id`)
- `prosm_module_grants` (for products running natively inside PROSM Platform — entitlement/authority grants without an activation code)
- `prosm_license_audit` (keyed by `product_id`, so it already covers every product, present and future)

PROSM Time-specific data (its own organizations, employees, sites, attendance, etc.) never lives in these tables or in PROSM Management's database at all — it lives entirely in PROSM Time's own standalone database (below). PROSM Management only ever holds licensing/entitlement *metadata about* PROSM Time, the same shape it holds for every other product.

**Standalone PROSM Time side (Phase 1):**
- `organizations`, `organization_settings`
- `users` / employee profiles
- `roles`, `permissions`, `admin_permission_assignments` (§9)
- `sites` (incl. `timezone`, `grace_tolerance`, `kiosk_mode`)
- `site_assignments`
- `projects`, `project_assignments`
- `work_schedules` / `shifts`
- `attendance_events`
- `attendance_sessions`
- `presence_sessions`
- `location_samples`
- `geofence_exceptions`
- `exception_actions`
- `camera_evidence`
- `break_events`
- `correction_requests`
- `sos_alerts`
- `device_bindings`
- `admin_on_behalf_actions` (§10 — distinct from employee self-reported events)
- `offline_sync_queue` (client-side, with server dedup log)
- `notifications`
- `timesheets`, `timesheet_approvals`, `timesheet_corrections`
- `license_activation_state` (local cache of PROSM Management's record, never authoritative)
- `audit_logs`

Final table structure must be designed through migrations only, with foreign keys, constraints, indexes, `created_at`/`updated_at`, and appropriate status/state modeling on both sides.

## 35. Backend & API Architecture

- Frontend never writes critical attendance state directly where business rules must be enforced.
- Supabase Edge Functions handle Clock In, Clock Out, geofence validation, exception actions, break events, correction requests, SOS alerts, administrative on-behalf actions, and other sensitive orchestration.
- PostgreSQL functions may enforce transactional invariants where appropriate.
- Idempotency keys protect Clock In/Out and all attendance sub-event endpoints from duplicate submissions, including offline-queued retries.
- Server timestamps are authoritative event time; client-captured timestamps are preserved for offline transparency.
- **The PROSM Management ↔ PROSM Time integration contract is its own versioned API** — kept fully separate from internal database access on either side.

## 36. Integration Readiness Requirements

- Keep core attendance domain logic independent from standalone authentication screens.
- Define adapter interfaces for identity, organization, site and entitlement providers.
- Keep external integration APIs versioned.
- Use stable domain IDs and explicit mapping when migrating data.
- Document data ownership for every entity, on both the PROSM Management side and the standalone side.
- Design UI shells so the same core screens can operate in standalone and integrated contexts.
- Do not hard-code standalone licensing assumptions into attendance domain logic.

## 37. UI / UX Screen Map

**PROSM Management (Phase 0 additions):**
- PROSM Time Product Registration
- Plans / Editions Management
- Entitlements Management
- License Records & Activation Code Issuance
- License Lifecycle (activate/suspend/renew/revoke)
- Activation & License Audit View

**Standalone PROSM Time (Phase 1):**
- Splash Screen *(logo/branding per §29, §33)*
- Activation / Welcome
- Organization Setup
- Admin Dashboard
- Employee Management
- Administrator & Permission Management *(new — §9)*
- Site Management + Map/Geofence (timezone, kiosk toggle, grace tolerance)
- Project Management
- Schedules/Shifts
- Employee Mobile Home
- Clock In / Camera Evidence Capture
- Break Start / Break End
- Clock Out
- Administrative Clock In/Out *(new — §10, admin-facing)*
- Active Presence / Status (incl. SOS action)
- Out-of-Zone Exception
- Correction Request (employee-submitted)
- Notifications
- Timesheets / Timesheet Approval (mobile-usable)
- Reports / Monthly Evidence Pack
- Audit
- Settings / Policies (incl. language, theme)
- Help & Support *(new — §32)*
- Kiosk Mode Screen (locked-down shared-device UI)
- License & Plan (read-only reflection of PROSM Management state)

## 38. Implementation Work Packages

| Package | Name | Scope |
|---|---|---|
| WP-00 | **PROSM Management — Generalize the Control Plane, Register PROSM Time** | Refactor the existing PROSM Management page into a generic, product-agnostic registry (products, plans, entitlements, licenses, activation codes, module grants) if not already generic; then register PROSM Time as its first product entry; build the reusable integration API contract (§6) |
| WP-01 | Repository & Architecture Foundation | Standalone repo structure, environment strategy, coding standards, shared domain conventions |
| WP-02 | Supabase Foundation | Independent Supabase project, migrations, RLS baseline, storage and Edge Function foundation |
| WP-03 | Authentication & Organization | Activation (consuming WP-00's API), organization setup, administrator onboarding, secure authentication |
| WP-04 | People & Roles & Permissions | Employee profiles, invitations, granular permission model (§9), device binding |
| WP-05 | Sites & Projects | Site creation, coordinates, radius, timezone, kiosk toggle, per-site grace tolerance, map configuration |
| WP-06 | Attendance Core | Clock In/Out, server validation, idempotency, attendance lifecycle |
| WP-07 | Administrative Attendance Actions | On-behalf Clock In/Out, actor/subject audit distinction (§10) |
| WP-08 | Camera Evidence | Capture, private storage, evidence linkage and retention |
| WP-09 | GPS & Geofence | Location validation, per-site accuracy/grace rules, geofence policy engine |
| WP-10 | Presence Monitoring | Active presence sessions, controlled location sampling, SOS action |
| WP-11 | Exception & Correction Workflow | Out-of-zone detection, employee reason, correction requests, manager workflow, audit |
| WP-12 | Break & Overtime Engine | Break lifecycle, overtime policy engine, timesheet integration |
| WP-13 | Notifications | Clock reminders, exceptions, approvals, escalation, SOS priority delivery |
| WP-14 | Manager Console | Operational dashboard, employee/site/exception management, permission administration, mobile-usable approvals |
| WP-15 | Offline & Sync Resilience | Local queuing, idempotent sync, pending-state UI |
| WP-16 | Timesheets | Period calculation, review, approval, locking and correction |
| WP-17 | Reports & Evidence Pack | PDF/print/export and monthly evidence package |
| WP-18 | Kiosk Mode | Shared-device UI, per-employee identification, fixed-site GPS handling |
| WP-19 | Localization | Arabic/English/French/German/Italian, RTL support, no hard-coded strings |
| WP-20 | Theming & Visual Identity | Dark/Light/System theme, PROSM logo-derived design tokens (§29), shared Web/Mobile token system |
| WP-21 | Navigation, Splash & Help | Role-aware navigation, splash screen, Help area, owner-supplied assets (§33) |
| WP-22 | Security Hardening | RLS audit, authorization tests, storage security, abuse controls, privacy/retention, data-subject rights |
| WP-23 | Production Readiness | Observability, error handling, backups, migrations, deployment, acceptance testing |
| WP-24 | PROSM Native Integration | Adapter layer, entitlement mapping, identity/site integration, controlled migration plan |

## 39. Definition of Done

- PROSM Management's PROSM Time product module (WP-00) is live and issuing real activation codes **before** any standalone-app work is marked complete.
- No placeholder implementation in production paths (except explicitly-flagged brand asset placeholders per §33).
- Every critical workflow has backend authorization; every permission in §9 is enforced server-side, not just hidden in the UI.
- RLS policies tested for cross-tenant isolation.
- Attendance state transitions are deterministic and auditable; administrative on-behalf actions are never confused with employee self-reported events.
- GPS calculations and accuracy/grace behavior are tested, including per-site tolerance.
- Camera evidence is private and access-controlled.
- Clock In/Out and all sub-events are idempotent, including offline-queued retries.
- Presence monitoring stops after Clock Out.
- Timesheets can be approved and locked, with overtime clearly separated.
- Corrections preserve immutable audit history.
- License/entitlement enforcement is server-side and sourced from PROSM Management only — never duplicated locally as an independent authority.
- Offline queuing and sync work correctly under intermittent connectivity.
- Kiosk mode produces individually auditable records, never anonymous/shared logs.
- SOS alerts are delivered with highest priority and never throttled.
- All five languages are functional with no hard-coded user-facing strings; Arabic RTL renders correctly.
- Dark mode is the default and theme switching works consistently across Web and Mobile.
- Visual identity/design tokens are derived from the actual supplied PROSM logo, not guessed.
- Splash Screen contains no business logic and displays `info@prosm.com` correctly in every language.
- Production deployment and migration process is documented for both PROSM Management (WP-00) and the standalone app.

## 40. Recommended Execution Order

1. **PROSM Management — PROSM Time product module (WP-00).** Nothing else starts until activation codes can genuinely be issued.
2. Foundation → Authentication/Activation (against WP-00) → Organization → Employee/Permissions → Site → Clock In → Camera/GPS validation → Clock Out.
3. Administrative on-behalf actions → Presence Session → Break lifecycle → Geofence Exception → Correction Requests → Notifications → SOS.
4. Manager Console (incl. mobile approvals, permission administration) → Offline/Sync resilience → Kiosk Mode.
5. Timesheets → Overtime engine → Approval/Lock → PDF/Evidence Pack.
6. Localization → Theming & Visual Identity (once logo supplied) → Navigation, Splash & Help.
7. Security hardening, data-subject rights, production acceptance.
8. Future PROSM Platform native integration (WP-24).

## 41. Final Architectural Decisions — Frozen for V3

- PROSM Management is generalized **first** into a product-agnostic control plane (WP-00) — products, plans, entitlements, licenses, activation codes, module grants — and PROSM Time is registered as its first entry. The standalone app is never built against a fictional/placeholder licensing authority, and PROSM Time never gets its own bespoke management subsystem when the generic one covers it.
- Any future PROSM application (standalone or native) registers into this same control plane. Building a new per-product management page/schema inside PROSM Management is the wrong outcome — it means the generalization step was skipped.
- PROSM Time standalone is a fully independent application: own repository, own Supabase project, own database, own Storage, own Edge Functions, own deployment.
- The standalone app and PROSM Management communicate **only** through a versioned, authenticated integration contract/API — never shared tables, never shared auth, never direct database coupling in either direction.
- Licensing authority is never duplicated — PROSM Management is the sole issuer/validator of record.
- Camera images are attendance evidence; no face recognition in V1.
- GPS/geofencing validates configured worksites, with per-site grace tolerance.
- Presence is tracked only during an active work session, stopping at Clock Out.
- Employee reason + manager notification/review for out-of-zone events, plus a self-correction request path.
- Offline-first attendance capture with idempotent sync.
- Both personal-device and kiosk-mode attendance capture, per site.
- Administrative on-behalf Clock In/Out is a distinct, permissioned, fully audited action — never conflated with employee self-reported attendance.
- Granular, server-enforced permission model — administrators are not automatically full Owners.
- Monthly approved/locked timesheets and evidence packs, with overtime as a distinct line item.
- SOS/Emergency action tied to the Safety Roll Call concept.
- One codebase for all editions; plans/entitlements controlled from PROSM Management.
- Full localization (Arabic, English, French, German, Italian) with RTL support; no hard-coded user-facing strings.
- Dark mode default, with Light/System options, consistent across Web and Mobile.
- Visual identity is derived from the actual PROSM logo supplied by the Product Owner — never guessed, never invented.
- `info@prosm.com` is the official information contact everywhere it's needed, in every language.
- Never fabricate PROSM brand assets — always placeholder + explicit request to the user when an asset is missing.
- Future integration into PROSM Platform is a controlled module integration/mapping process, never an uncontrolled database merge.

## 42. Final Execution Principle

```
PROSM Management   =  UNIVERSAL CONTROL PLANE for every PROSM product/module
                       (Time, Fleet, anything built later — one registry, not one per product)

PROSM Time              =  first registered PRODUCT (standalone today)
Any future application  =  another registered PRODUCT — same control plane, no new subsystem
PROSM Platform Native   =  MODULE mode (future, per product)

Standalone flow (any product, PROSM Time included):
  PROSM Management  (generic: products → plans → entitlements → licenses → activation codes)
        ↓  (Activation / License, via the same versioned API contract for every product)
  <Standalone Product, e.g. PROSM Time>
        ↓
  That product's own Supabase project

Native PROSM Platform flow (future, any product):
  PROSM Management
        ↓  (Module Grants — entitlements/authority, no activation code)
  PROSM Platform
        ↓
  <Product's Native Module>

Adding a new PROSM application later means: register it as a new row in PROSM Management's
existing product registry. It never means building it a separate management subsystem.
```

**Never mix the two models. Never duplicate the licensing authority. Never bypass PROSM Management. Never directly couple any standalone product's database tables to the main PROSM Platform database. Never build a product-specific management subsystem when the generic one already covers it.**

---

## 43. Instructions to Claude Code (Build Kickoff Brief)

**Read this section first before writing any code.**

1. **Phase order is mandatory.** Start with §6/WP-00: inspect the existing PROSM Platform repository and its PROSM Management architecture, then generalize/extend it into a product-agnostic control plane and register PROSM Time as its first product (registration, plans, entitlements, license/activation issuance, audit). Do not begin the standalone PROSM Time application until this is genuinely functional.
2. **Scope boundary inside the existing PROSM Platform repository — hard limit.** The *only* part of that repository Claude Code may touch is the platform-management area: the management page/module itself, its schema (`prosm_products`, `prosm_product_plans`, `prosm_entitlements`, `prosm_license_records`, `prosm_activation_codes`, `prosm_module_grants`, `prosm_license_audit`), and the activation/entitlement API it exposes. Everything else in that repository — core platform auth, other existing modules, customer-facing platform UI, the platform's primary database outside these tables — is strictly off-limits and must not be modified, refactored, or "improved" along the way, even incidentally.
3. **Preserve existing PROSM Platform architecture.** Do not introduce a duplicate management system, a second licensing authority, or a competing permissions framework inside PROSM Management — extend what exists, within the boundary in point 2.
4. **Standalone repository:** once WP-00 is functional, initialize a **new, independent** GitHub repository for PROSM Time (confirm name/org/visibility with the user). Standard structure: `/src`, `/supabase/migrations`, `/supabase/functions`, `/docs`, `.env.example`, README referencing this master file.
5. **Standalone Supabase:** create/connect a **new, independent** Supabase project for PROSM Time — never reuse credentials, project refs, or connection strings from PROSM Platform or PROSM Management. Confirm project details with the user first.
6. **Integration contract only.** The standalone app must consume PROSM Management's activation/entitlement API — never query PROSM Platform's database directly, never share auth secrets between the two systems.
7. **Assets & branding:** never invent a logo, brand palette, icon set, or product photography. If the official PROSM logo or other owner-supplied assets haven't been provided yet, use clearly labeled placeholders and explicitly ask the user for the real assets before finalizing any branded screen or the design-token system (§29, §33).
8. **Execution order:** follow §40. Build vertical slices, not all screens at once. Confirm with the user at the end of each Work Package (§38) before moving to the next, unless told otherwise.
9. **Definition of Done (§39)** is the checklist for every Work Package before marking it complete.
10. **Integration boundary for the future:** nothing built in Phase 1 should hard-code an assumption that it lives inside PROSM Platform. Follow §36 so future native integration stays a controlled adapter process, not a rewrite.
11. **When in doubt** about scope, policy defaults, the logo/asset status, or anything not fully specified here — ask the user rather than guessing.

---

*End of PROSM Time Implementation Master File V3.0*
