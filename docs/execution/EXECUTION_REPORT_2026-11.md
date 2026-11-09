# Execution report — branch `feature/platform-hardening-and-payroll` (2026-11-04 → 2026-11-09)

Status: every database migration and edge function below is **live** on the production project
(`wcfdhsxzeryqwpmftgay`). The app itself (web build and the Google Play AAB) is **not released**;
there is one release at the end, on the owner's word.

Each line: what was asked → what was done → how it is proven. Tests are under `supabase/tests`
(PGlite, `npx vitest run --config vitest.db.config.ts <file>`) unless marked *unit*.

## Permissions and governance

| Item | Done | Proof |
|---|---|---|
| Grant permissions (owner's full authority to a person, and withdraw) | `771317a` | `ownerDelegation*`, `delegationLimits` |
| Delegation with limits: window, full / partial scope, sovereign actions stay with the real owner, nobody decides their own request | `e0c4ad3` | `delegationLimits` |
| B-01 change a person's role: owner, or `permissions.assign` for a lower role over people under one's authority; permissions follow at once; site management removed below manager; remaining direct grants returned for review; audited | `333899a`, migration `20261109200000` | `roleChangeAndReviewers` (B-01 block) |
| B-04 leave reviewers from real data only: own site's manager and the owner, never another site's manager; active delegates with leave approval appear and drop out when the delegation ends; server refuses anyone else | `333899a` | `roleChangeAndReviewers` (B-04 block), `leaveEmails` |
| Security hardening: managers read shifts and external workers at their own sites only; cross-organisation helpers closed; one audit trigger | `6c38ac2` | `crossTenant`, `anonGrants`, `securityHardening*` |
| Step-up re-authentication for sensitive actions | **Not built** — see "Not built" below | — |

## Attendance, leave, dashboard

| Item | Done | Proof |
|---|---|---|
| Leave counts working days only (one calendar source; request of only rest days / holidays refused) | `00a3750` | `leaveWorkingDays` |
| B-06 dashboard: absent and on leave as two cards and lists; each card states what it counts; not-clocked-out also catches a session left from a previous day | `91f26e5` | `dashboardAbsence`, `dashboardOverdue` |
| KPI review: today's figures independent of the chosen period; no absence on a rest day or before the shift starts; one absence rule for card, list, sites table and overview | `68e52cb` | `dashboardTodayFigures` |
| B-08 map buttons follow the language direction; logo / dashboard button refresh | `61a8b0b` | no automated test |
| B-09 one named clock-in button; nobody is clocked out without agreeing (AUTO sites: reminder, then the person agrees) | `01daef4`, `40a6fad` | `exitSiteCheckout` |
| B-10 every notification type opens the right screen | `9b95d57` | `notificationRouting` |
| B-05 sidebar and settings follow the target tree; old links keep working | `0fc944e` | *unit* `navigation` |

## Payroll

| Item | Done | Proof |
|---|---|---|
| Payroll module (settings, components and visibility, profiles with effective dates, cycles, snapshots and versions, installments, attendance suggestions) | `b52cf69`, `bc36ce2` | `payroll*` |
| Payslip by email on the employee's request, one-click send by an allowed manager | `513be2a` | `payslipEmail` (7 tests) |
| Layout like the owner's reference images; amount in words | `64d0fb9` | *unit* `amountInWords` |
| Reports belong to the customer: customer logo first, PROSM Time small, footer "issued via PROSM Time" — on every PDF report | `68825e5` | visual check 2026-11-09 |
| 15.14 copy variable lines from the previous cycle; one line to several people | `a9dc7d2` | `payrollProductivity` |
| 15.11 bulk payslip export in the background (ZIP in a private bucket, serial per payslip) | `fe89974` | `payrollExportJobs` |
| 8.1 export for everyone, one site or the chosen people | `1117c3f` | `payrollExportJobs` |
| 15.15 load test: 1,000 employees × 30 lines — report 85 s → 2.6 s | `54eca5e` | `payrollLoad`, `PAYROLL_LOAD_TEST.md` |
| Payslip = summary for every employee including rounding; history kept after deactivation / removal | `2fc0747` | `payrollIntegrity` |
| B-07 external labour pay (rates by hour…year, pay runs, adjustments with reasons, approve / reopen, own permission) | `aaa58c0`, `0fd17a5`, `20a6552` | `externalLaborPay` |

## Integration API

| Item | Done | Proof |
|---|---|---|
| API v1: read-only scopes, expiry, test/live keys, one key check, request log, OpenAPI contract | `f77fd5f` | `integrationApi` |
| v1a: shifts, leave balances; attendance received through the API, idempotent, pending until approved | `cb3ed52` | `integrationApiV1a` |
| v1b webhooks: outbox, HMAC signatures with key id, retries, dead after 8, endpoint off after 20 | `a88e3d1` | `webhooks` |
| Hardening: public HTTPS on 443 only (checked at add and at every delivery), no redirects, retention 90 / 30 / 180 days | `053dc8f` | `webhookSafety` |
| API on and shown; every plan includes it until the packages session decides | `7f4a88d`, migration `20261109210000` | *unit* `navigation`, `planFeatures` |

## Closed by the owner without work (2026-11-09)

- B-12 battery / data use and B-13 the radio: left as they are.
- The "you entered the site" notification: not built.

## Not built, and why

- **Step-up re-authentication** (asking for the password again before a sensitive action). The
  current sign-in (Supabase Auth: email + password session, refresh token) has no server-side
  "recently re-authenticated" claim that a database function can check. A client-only password
  prompt would be cosmetic: the RPC would still accept the session. Doing it properly needs one
  of: Supabase MFA with an `aal2` check in the sensitive RPCs, or a short-lived re-auth token
  issued by an edge function after a fresh password check and verified by each RPC. Until then,
  sensitive actions are protected by the permission model, a required reason, and the action log.
- **Backup restore test**: needs a separate project to restore into — see `BACKUP_RESTORE.md`.
