# PROSM Time — Code & Distribution Hardening

Scope: protect the shipped Web, Android (APK) and Windows (Electron) artefacts
against casual code theft, inspection and tampering — **without changing any
application behaviour, UI or business logic**.

Honest baseline: any client the customer can install can, with enough effort, be
unpacked. The goal here is to raise the cost from *minutes* to *serious,
deliberate reverse-engineering*, and to make sure nothing of real value (secrets,
authorisation decisions, business rules) lives in the client at all.

---

## Layer 1 — Build-level obfuscation

- `vite.config.ts`: `minify: "terser"`, two compress passes, identifier mangling,
  all comments stripped, `sourcemap: false`, opaque hash-only chunk file names.
  This alone is `npm run build`'s real, always-on protection.
- `scripts/obfuscate.mjs` (a SECOND, separate pass applying `javascript-obfuscator`
  on top of the already-terser-minified output: hexadecimal identifiers, encoded
  + rotated + shuffled string array, string array wrappers, numbers-to-expressions)
  is **currently disabled by default** — real gap found 2026-09-11: a real signed
  release APK built with this pass produced an immediate, un-reproduced-in-dev
  crash on a real device (React's ErrorBoundary fallback, "Something went wrong",
  right after a fresh install), while the exact same source rendered cleanly in
  every local check (tsc, vitest, an authenticated jsdom render). Never
  runtime-tested on a real device before it first shipped in a signed build - the
  earlier build+size+syntax checks (bundle grew ~2.7x, `node --check` passed on
  every chunk) proved the pass *ran*, not that its *output behaved correctly* at
  runtime. Root cause not yet isolated (a terser-then-obfuscator double-pass is
  an unusual, higher-risk pipeline - most guides run one or the other, not both in
  sequence). Opt back in explicitly with `npm run build:obfuscated` once a real
  device has confirmed it doesn't reproduce the crash; do not wire it back into
  the default `build` script (or CI) before that.

All three distributions build from the same `dist/`, so all three inherit this.

## Layer 2 — No developer conveniences in a release

- `drop_console` and `drop_debugger` in the Terser pass (always on); the
  obfuscator's own separate `disableConsoleOutput` is part of the currently
  disabled Layer 1 second pass above.
- No source maps are emitted or packaged (`!**/*.map` in the electron-builder
  `files` list, `**/*.map` excluded from the APK packaging).
- Electron: DevTools disabled (`devTools: false`), application menu removed,
  F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+U swallowed, and any programmatic
  `openDevTools()` closed again. `PROSM_TIME_DEVTOOLS=1` restores the inspector
  when running unpackaged from source.
- Electron: `asar: true` — `dist/` is packed instead of sitting as loose files.
- Electron: popups denied and off-origin navigation blocked; external `https://`
  links open in the user's real browser instead of inside the shell.
- Android: `WebView.setWebContentsDebuggingEnabled(false)` in release, so
  `chrome://inspect` cannot attach to the shipped app.

## Layer 3 — Android (APK) hardening

- `minifyEnabled true` + `shrinkResources true` with `proguard-android-optimize`;
  `proguard-rules.pro` keeps the whole Capacitor bridge, every `@PluginMethod`
  and `@JavascriptInterface`, and `net.prosm.time.**` — behaviour is unchanged.
- `android.util.Log` v/d/i/w calls stripped from the release binary.
- `debuggable false` on release.
- `allowBackup="false"` + `data_extraction_rules.xml`: session tokens and cached
  evidence cannot be pulled out of a cloud backup or device-to-device transfer.
- `usesCleartextTraffic="false"` + `network_security_config.xml`: HTTPS only, and
  user-installed CAs are not trusted in release — a proxy tool cannot casually
  record the API traffic to reconstruct the backend contract.
- The release APK is signed with a real local upload keystore (see "Signing"
  below) - the `assembleDebug` builds this session used earlier today were
  unsigned and did not carry the ProGuard/R8 protection above at all (`debug`
  build type keeps `minifyEnabled false` deliberately, so local development
  stays fast and inspectable) - only `assembleRelease` carries this layer.

## Layer 4 — The real protection: nothing valuable in the client

This is what actually stops theft, and PROSM Time is already built this way —
the layers above only protect what is left.

- Every privileged operation is a Supabase Edge Function
  (`supabase/functions/*`): clock in/out, breaks, timesheets, approvals,
  exceptions, allowances, invitations, kiosk PINs, payroll sync, data
  export/erasure, SOS. The client asks; the server decides.
- Authorisation and tenancy are enforced server-side (RLS + function checks),
  not by the UI. A stolen and re-hosted copy of the bundle still cannot read or
  write another organisation's data.
- Licensing is server-validated via `refresh-license-status`; a cracked client
  cannot mint entitlement.
- Only `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` reach the bundle — public
  by construction. All secrets (`PROSM_MANAGEMENT_API_KEY`, service role) live
  as Edge Function secrets and never enter client code (`.env.example` §WP-01).

**Rule going forward:** if a new feature needs a secret, a price, a quota or a
permission decision, it goes in an Edge Function — never in the bundle.

---

## Signing

- **Android**: a real local upload keystore (`android/app/prosm-time-release.keystore`,
  git-ignored) signs every `assembleRelease` build. This keystore must be
  preserved forever - losing it means every future release can never be signed
  with the same identity again, and users could not install an update over an
  existing install. Back it up somewhere durable outside this repo.
- **Windows**: still unsigned - a real commercial code-signing certificate
  (DigiCert/Sectigo/etc.) needs to be purchased; this is not something that can
  be generated locally the way the Android keystore was. Until then, Windows
  SmartScreen will warn on first run of the installer - a known, expected state,
  not a build failure.

## Recommended next steps (outside the codebase)

1. **Buy a Windows code-signing certificate** — removes the SmartScreen warning
   and proves the binary is untampered.
2. Consider the Play Integrity API if the app ever ships through Google Play.
3. Keep source maps out of every hosting environment (already the case).
