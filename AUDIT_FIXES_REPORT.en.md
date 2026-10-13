# Audit fixes report — PROSM Time

**Date:** 2026-10-13
**Basis:** the security and code audit of `main` (`37e3858`) and a full user-level E2E test (92 scenarios: 87 passed, 5 failed).
**Status:** deployed to Supabase (10 migrations, 9 Edge Functions) and released to users as **v2.3.19** on 2026-10-13, with the owner's approval. See "Deployment".

> English translation of `AUDIT_FIXES_REPORT.md`, brought up to date after the deployment. The work started in an earlier session that ended unexpectedly after item 1.2; it was resumed from item 1.3 after confirming everything before that was saved in commits.

## Final check results

| Check | Result |
| --- | --- |
| `npx tsc -b` | No errors |
| `npx eslint .` | No findings |
| `npm run check:i18n` (new) | 1144 keys, all present in the five languages |
| `npm test` (app tests) | 16 files, 38 tests, all passing |
| `npm run test:db` (database tests, PGlite built from every migration) | 13 files, 79 tests, all passing |
| Building a fresh database from every migration | 0 errors (was 24) |
| The RLS audit query from item 1.1 | 0 rows, locally and on the live database |
| GitHub CI and the release build | All jobs passed (v2.3.19) |

Every fix has a test that **fails before the fix and passes after it**. This was actually tried each time by removing the fix and re-running the test.

New CI: `.github/workflows/ci.yml` runs tsc, eslint, the translation check, the app tests and the database tests (including the fresh-database build) on every push and every pull request.

---

## Items

| # | Item | Status | Commit | Main files | Test |
| --- | --- | --- | --- | --- | --- |
| 1.1 | One organisation's owner could read another organisation's data (RLS) | ✅ Done | `c0de6d0` | `supabase/migrations/20261013110000_tenant_scope_leave_and_shift_policies.sql` | `supabase/tests/crossTenant.test.ts`: two organisations, an owner, manager and employee in each, every table (coverage enforced) and 31 RPCs |
| 1.2 | "My upcoming shifts" showed other people's shifts | ✅ Done | `b6f60cd` | `ShiftRepository.ts`, `LeaveRepository.ts` (`listMine`) | `src/core/repositories/listMine.test.ts` |
| 1.3 | The kiosk screen was not locked | ✅ Done | `ef43504` | `src/modules/kiosk/KioskLayout.tsx`, `KioskLockGuard.tsx`, `kioskLock.ts`, `src/routes/AppRoutes.tsx`, `useAndroidBackButton.ts` | `src/routes/kioskLock.test.tsx` (3/3 failed before) |
| 1.4 | Employees could choose their own clock-in time | ✅ Done | `0db9f2a` | `20261013120000_server_time_for_live_attendance.sql`, `AttendanceRepository.ts`, `OfflineQueueService.ts`, 5 Edge Functions, Attendance Log, Manager console | `supabase/tests/offlineTime.test.ts` (9), `attendanceTime.test.ts` |
| 2.1 | "Geofence required" did not block clock-in | ✅ Done (owner chose option a) | `d0617b0` | `20261013190000_block_clock_in_outside_area.sql`, `SitePolicySettingsCard.tsx` | `supabase/tests/clockInOutsideArea.test.ts` |
| 2.2 | The Location Violations report ignored geofence violations | ✅ Done | `0d0815f` | `20261013130000_location_violations_include_geofence.sql`, `ReportRepository.ts`, `ReportsPage.tsx` | `supabase/tests/locationViolations.test.ts` (4) |
| 2.3 | The repository is public | 🟡 Partly done (owner approved) | `026548a` | `.github/workflows/release.yml` | Update manifest, APK and web build on Supabase Storage, verified live; the Windows installer awaits a decision |
| 2.4 | No fake-GPS detection | ✅ Done | `39b17ed` | `20261013180000_mock_location_detection.sql`, `BackgroundLocationService.ts`, `ClockInOutCard.tsx`, `MockLocationSettingsCard.tsx` | `supabase/tests/mockLocation.test.ts` (4) |
| 2.5 | Migrations could not build a fresh database | ✅ Done | `f0df182` | The 24 files, `README.md`, `ci.yml` | `supabase/tests/freshDatabase.test.ts` (24 errors before, 0 after) |
| 3 | No backend tests | ✅ Done | `2e37c3e` (harness in `7cf992b`) | `supabase/tests/lifecycle.test.ts`, `supabase/tests/support/*` | 27 tests (T10 failed before 1.4) |
| 4.1 | Generic message for a wrong kiosk PIN | ✅ Done | `d5ccafa` | `humanizeBackendError.ts`, `kiosk-clock-in/out` | `humanizeBackendError.test.ts` |
| 4.2 | The app opened in English on an Arabic device | ✅ Done | `e815ec6` | `src/i18n/languages.ts`, `index.ts` | `src/i18n/languages.test.ts` |
| 4.3 | The site role always defaulted to "Member" | ✅ Done | `1fadad6` | `AssignSiteMemberModal.tsx` | `AssignSiteMemberModal.test.tsx` |
| 4.4 | A supervisor could clock their own manager in/out | ✅ Done | `7de3f54` | `20261013150000_on_behalf_only_below_caller.sql`, `roleRank.ts`, `AdminOnBehalfPage.tsx` | `supabase/tests/onBehalf.test.ts`, `roleRank.test.ts` |
| 4.5 | SOS alerts reached managers of other sites | ✅ Done | `f103b4a` (site name in `7cf992b`) | `20261013160000_sos_recipients_site_scoped.sql` | `supabase/tests/sosRecipients.test.ts`, `sos.test.ts` |
| 4.6 | Ongoing presence monitoring only in Settings | ✅ Done | `12fff82` | `SiteFormModal.tsx`, `SitePolicySettingsCard.tsx` | `SiteFormModal.test.tsx` |
| 4.7 | An allowance entry used only the day's last session | ✅ Done | `fd88a11` | `AllowanceRepository.ts`, `AllowancesPage.tsx` | `allowanceDay.test.ts` |
| 4.8 | One trip outside the area asked for a reason twice | ✅ Done | `6181a8a` | `20261013170000_one_reason_per_trip.sql` | `supabase/tests/exceptionReason.test.ts` |
| 4.9 | Timesheet PDF text is an image | ⏳ Deferred | — | — | — |
| 4.10 | Verify the invitation relay on dev | ⏳ Not verified | — | — | — |
| 5.1 | 21 functions executable by `anon` | ✅ Done | `ec70523` | `20261013140000_revoke_anon_execute.sql` | `supabase/tests/anonGrants.test.ts` (fails in CI if any new function becomes callable by anon) |
| 5.2 | 3 missing translation keys | ✅ Done | `32d35c5` | `common.json` ×5, `scripts/check-i18n.mjs` | The check: 25 missing before, 0 after |
| 5.3 | `x-trial-secret` compared without constant time | ✅ Done | `3aacbec` | `_shared/constantTime.ts`, `send-trial-notices` | `supabase/tests/constantTime.test.ts` |
| 5.4 | `npm audit` | ✅ Partly done | `e7c19e8`, corrected in `558af19` | `package-lock.json` | Clean `npm ci`, tsc, tests and the build pass |
| — | SOS button on every shift (owner decision 2026-10-13, option a) | ✅ Done | `7cf992b` | `20261013100000_sos_on_every_shift.sql` | `supabase/tests/sos.test.ts` (4) |

---

## Implementation details

### Priority 0

**1.1:** The three SELECT policies (`leave_requests`, `leave_entitlements`, `shift_assignments`) were recreated with `organization_id = current_prosm_time_organization_id()` as an outer AND around the whole expression. The audit query from the review returns 0 rows. The test is table-driven: any new table that isn't added to it fails the coverage test.

**1.2:** `listMine` for shifts and leave now filters on the signed-in user instead of relying on RLS.

**1.3:**
- `/kiosk/:siteId` moved out of `AppShell`, so there is no sidebar, search or user menu.
- The device is locked to the kiosk: any other address, the browser back button and reloading all lead back to it. The Android back button is disabled while the kiosk is open.
- Leaving requires **the password of the account that opened the kiosk**, checked by Supabase Auth.
- **Proposal (not built, as you asked):** a separate kiosk device session bound to one site that can only call the kiosk RPCs, instead of running on the owner's session. This removes the risk at the root even if the device is left open, but needs a design for activation, revocation and key rotation.

**1.4:**
- Live (online) actions are **always recorded with the server's time**. `client_reported_at` is still stored for reference but is no longer used as the time.
- Only a replay from the offline queue (`p_offline_replay`, sent only by `OfflineQueueService`) keeps the device's time, within the same window as before (24 hours back, 5 minutes ahead).
- When the device time differs from the server's by more than 2 minutes:
  - the action is marked `time_source = 'device_offline'`;
  - a review item is created in a new `offline_time_reviews` table, shown in the Manager console under "Pending review" and reviewed through `review-exception`;
  - a "Device time (offline)" badge appears in the Attendance Log and the attendance report/PDF.
- A replay is refused if its time is before the employee's last recorded action, or on a day of approved leave (in the site's time zone).
- The same rule applies to clock in, clock out, break start, break end and site change.
- The audit's acceptance cases are all covered by tests: a live clock-in sent with a time 2 hours ago → server time. An offline replay 2 hours ago → device time, flagged, one review. A replay before the last action → refused. Elapsed time after reconnecting is correct.
- The review decision is stored on the review item. Rejecting does not change the time automatically; it is corrected through a correction request or an admin edit as usual.

### Priority 1

**2.1: done with option (a), the owner's decision.**
- **Before:** "Geofence required" only blocked employees **not assigned** to the site. An assigned employee could clock in from anywhere; an exception was created and the owner notified.
- **Now:** a new site setting in Settings, "Block self clock-in outside this site's work area" (`block_self_clock_in_outside_geofence`). It is off by default and excludes exempt employees, mirroring the existing clock-out setting.
- **For the employee:** when the setting blocks them, they see a message telling them to contact their manager.

**2.2:** The "Location Violations" report now includes geofence exceptions (clock in/out and ongoing monitoring) next to the "implausible location" flags. The report has new columns: type, the employee's reason, and review status. Managers stay limited to their own sites.

**2.3: partly done, with the owner's approval.**
- New builds read the update manifest from `app-releases/latest-version.json` on Supabase Storage. Its Android and web links point to Storage too. All three were verified live for v2.3.19.
- The GitHub secret `SUPABASE_SERVICE_ROLE_KEY` was set. It had never existed, so the mirror had never actually been uploaded. The mirror steps now fail loudly if it is missing.
- **The Windows installer (about 120 MB) cannot be uploaded:** Supabase rejects any file over 50 MB (tested: 413 EntityTooLarge). It stays on GitHub Releases until you choose one of:
  - upgrade Supabase to a paid plan, or
  - create a small public repository for releases only.
- Do not make the repository private before (1) devices have installed v2.3.19, and (2) the Windows installer is decided. Builds before v2.3.19 still read the update manifest from GitHub, and the manifest committed in the repository is kept for them.

**2.4:**
- On Android the app reads the "simulated location" flag. It uses `isFromMockProvider` from the existing location plugin, so there is no new native code.
- The reading is taken with the clock-in/out position, best effort, and never blocks clocking. The flag is also sent from the offline queue.
- The server stores the flag on the event. A simulated location opens a review item for the site's managers and the owner (`mock_location_flags`), and appears in the Location Violations report as "Fake location".
- A new owner setting, "Reject clock-in/out from a fake location" (Settings, off by default), refuses it instead.
- Browsers, iOS and desktop send "unknown", so nothing is recorded.
- **Not yet tried on a real Android device.** Try it with a mock-location app before relying on it.

**2.5:**
- The 24 files are kept, so production history is unchanged. Each got a guard: when the production PROSM organisation is absent, it writes `RAISE NOTICE 'skipped: …'` and returns.
- In production they behave as before, and they are already applied, so they won't run again.
- **Note:** this edits already-applied migrations. It is an exception the audit itself asked for in this item, and it does not affect the production database.
- `README.md` has a new rule: verification scripts belong in `supabase/tests/`, not in `migrations/`.
- A new test builds a fresh database from every migration and fails on any error; it runs in CI.

### Priority 2

**3:**
- `time_lifecycle.mjs` became `supabase/tests/lifecycle.test.ts` (27 tests).
- `@electric-sql/pglite` was added as a devDependency.
- `supabase-stub.sql` and `stub_extra.sql` are in `supabase/tests/support/`.
- Added suites: cross-tenant, `listMine`, 1.4, 2.1, 2.2, 2.4, 2.5, 4.4, 4.5, 4.8, 5.1, 5.3 and SOS.
- They run in CI on every push.

**4.1:**
- **The real cause:** the server wraps its expected errors (`KIOSK CLOCK IN FAILED: INCORRECT PIN`), and the app matched the text exactly, so no translation was found.
- **The fix** is in `humanizeBackendError`: the wrapper is removed and the inner message is looked up. This also fixes the same problem on other screens; unexpected errors still get the generic message.
- New messages: "This number is not registered at this site", the worker states, and the attempt limit.
- The kiosk PIN now locks after **5** tries per person within 15 minutes (was 8), for 30 minutes. Server errors stay generic.

**4.2:**
- On first launch the device or browser language is used when supported (`ar-EG` → Arabic), otherwise English. A language chosen in the app takes priority.
- **Note:** this replaces an earlier rule of yours that forced English on every fresh install. I followed your newer request in the audit.

**4.3:** The site role starts from the person's organisation role: Manager or Supervisor → Site manager, everyone else → Member. The owner can still change it; the server check is unchanged.

**4.4:** Clocking in/out on behalf is allowed only for people below the caller's role (manager > supervisor > employee/read-only); the owner may act for anyone. This is enforced in the on-behalf clock-in/out RPCs, and the list in the app shows only the same people.

**4.5:**
- **The decision implemented, as the audit suggested:**
  - Recipients are the site's own managers plus the owner, always. With no site, the owner alone.
  - Coworkers clocked in at the same site are still notified, as before.
- The Emergency Log (RLS) follows the same reach.
- The site name is stored with every alert since `7cf992b`.

**4.6:** Since `7cf992b` the SOS button no longer depends on ongoing monitoring. The site form now mentions the setting and has an "Open this site's settings" link that opens Settings with the site already selected.

**4.7:** An allowance entry covers the whole day: the first clock-in and the last clock-out (blank while a session is still open), and the details show the number of sessions and hours worked. Reports and exports built from the same entries follow.

**4.8:** The reason an employee gives also covers their other exceptions still waiting for a reason from the same trip (within 12 hours). Each exception stays its own row for review and reports.

**4.9: deferred.**
- **Why:** rendering the timesheet PDF as an image was a deliberate choice, because jsPDF's built-in font does not support Arabic.
- Real text needs an embedded Arabic font (hundreds of KB in the light app), plus letter shaping and RTL direction in every PDF report.
- That is not "cheap", and it is low priority as you said.

**4.10: not verified.** It needs access to a dev environment on Supabase. Showing the code to the owner remains the fallback when the relay is unavailable.

### Hygiene

**5.1:**
- Execute was revoked from `public` and `anon` on every overload of the 21 functions (signatures read from the catalog), and granted to `authenticated` and `service_role`.
- A CI test fails if any public function becomes executable by `anon`, except through an explicit allow-list (currently empty).
- On the live database, no function is callable without signing in.

**5.2:**
- "Actions", "Status" and "Save" were added in the five languages.
- `scripts/check-i18n.mjs` (`npm run check:i18n`) was added and runs in CI. It found exactly the three missing keys and nothing else.

**5.3:** `secretsMatch()` computes SHA-256 of both values, then compares them in constant time.

**5.4:**
- `npm audit fix` without `--force` first updated several packages. It also moved `app-builder-lib` to a version the project's patch file does not support, which stopped CI and the first release attempt at `npm ci` (nothing was published).
- **Corrected in `558af19`:** the lock file was restored, and only `dompurify` was updated (3.4.14 → 3.4.17, the advisory that reaches the app through jsPDF). This was checked with a clean `npm ci`.
- **The remaining advisories are all in build tools:** Capacitor CLI/assets, electron-builder, patch-package and sharp. They need breaking major upgrades and your decision. Keep `app-builder-lib` at 26.15.3 while `patches/` pins it.

---

## Additions after the report (2026-10-13)

- **Page name cards** (`42c8853`): a small card, about 76 px tall, with the page name, a short line about it and a flat 2D illustration with people. It is used on 16 pages, replacing the cropped pictures. The illustrations are from unDraw (MIT license, recoloured to PROSM green), and their size went from 2.2 MB to 316 KB.
- **Offline and network-problem messages** (`9d44088`):
  - When offline, a friendly card with an illustration says clock in and clock out still work.
  - When the connection returns, a "back online" note shows briefly.
  - The "this page needs a connection" and "something went a little wrong" screens now have illustrations.
  - Any request that never reached the server shows a clear message instead of technical text.
- **The SOS button:**
  - It is present on every shift confirmed by the server.
  - Verified across the whole code path, by 7 database tests, and on the live server: the function is deployed and refuses callers who aren't signed in.
  - A real send was not tried, because it would send actual alerts to the owner and managers.

## Deployment — done (2026-10-13)

- **10 migrations** applied to `wcfdhsxzeryqwpmftgay` (`20261013100000` to `20261013190000`). A dry run confirmed beforehand that only these would be applied.
- **9 Edge Functions** deployed: trigger-sos-alert, clock-in, clock-out, start-break, end-break, change-site, kiosk-clock-in, kiosk-clock-out and send-trial-notices.
- **Checks on the live server:** the RLS audit query returns 0, no function is executable without signing in, and the new functions and columns exist.
- **Release:** pushed to `main`, rebased on the bot's v2.3.18 version bump. GitHub CI passed. The release workflow built and published **v2.3.19** (Windows, Android, web). The update manifest is served from Supabase Storage, and its links answer 200.

## Still open

1. **Windows installer (2.3):** choose a paid Supabase plan or a public releases-only repository, then make the main repository private once devices are on v2.3.19.
2. **4.9** (text PDF) and **4.10** (verify the relay on dev).
3. **5.4:** breaking upgrades of build tools.
4. **1.3, point 4:** a separate kiosk device session (proposal).
5. Try 2.4 on a real Android device with a mock-location app.
6. Optional: a real SOS test with a test account, warning the owner and managers first.
