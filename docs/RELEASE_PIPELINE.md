# PROSM Time - Release Pipeline

The pipeline is part of the security boundary. Nothing reaches users from a
build that did not pass every gate below.

## Single source of version truth

`package.json` `version` is the only place a release version is set.

- `npm run version:sync` writes it into `android/app/build.gradle`
  (`versionName`, plus a monotonic derived `versionCode`).
- `npm run version:check` fails the build when anything drifts.
- `src/core/appVersion.ts` reads the same value, so the running app, the
  installer, the APK and the release manifest always agree.

## Stages

| Stage | Workflow | What it proves |
| --- | --- | --- |
| Validate | `ci.yml` | version consistency, lint, typecheck |
| Test | `ci.yml` | unit + security regression tests, database assertions against real PostgreSQL |
| Build web | `ci.yml` | production build with minification and obfuscation |
| Security gate | `ci.yml` | `scripts/security-gate.mjs` - 26 hard checks |
| Build Android | `release.yml` | R8/resource-shrunk signed release APK + AAB |
| Build Windows | `release.yml` | signed NSIS installer |
| Artifact validation | `release.yml` | required artifacts exist and are non-empty |
| Publish | `release.yml` | GitHub Release with all artifacts |
| Deploy web | `release.yml` | web deploy hooks + published release manifest |

## The security gate

`npm run security:gate` runs after every build and stops the release on any
regression. It re-proves:

- no service-role key, secret API key, management key, signing key or private
  key appears anywhere in `src/`, `dist/` or `electron/`
- the web build has no source maps, is terser-minified, drops console and
  debugger, and is obfuscated
- the desktop build is packed as asar, blocks devtools and off-origin navigation
- Android release builds use R8, shrink resources, are non-debuggable, forbid
  cleartext traffic and disable backup extraction
- the shared license gate calls the server-side RPC and **fails closed**
- all nine protected operations pass through the license gate
- every `SECURITY DEFINER` function pins `search_path`
- installation tables have RLS, secrets are stored hashed, grace is computed
  from the server clock
- password-reset hardening and the SQL regression suite are still present
- the Android version matches `package.json`

Obfuscation and devtools removal are counted as hardening, never as the
security boundary. Enforcement is server-side.

## Update detection

`npm run release:manifest` writes `dist/release-manifest.json`
(version, notes, security flag, HTTPS download pages). Clients poll it at
startup and every six hours:

- **Web** - clears caches and service workers, then reloads.
- **Android / Windows** - open the official download page; nothing installs
  silently.

Only `https://` download links are accepted; a malformed manifest is ignored
and the app keeps running on its current version.

## Required repository secrets

| Secret | Used for |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | signing the APK/AAB |
| `WINDOWS_CERT_BASE64`, `WINDOWS_CERT_PASSWORD` | signing the Windows installer |
| `PROSM_WEB_DEPLOY_HOOKS` | comma-separated web deploy hooks |

No signing material or server secret is ever committed to the repository.

## Cutting a release

```bash
npm version <new-version>   # single source of truth
npm run version:sync
git push --follow-tags
```

The tag push runs `release.yml` end to end.

## Activating the workflows

The two workflow files live in `ci/workflows/`. GitHub only runs workflows
from `.github/workflows/`, and writing there requires the `workflow`
permission, which the current integration does not hold. Activate them once
with:

```bash
mkdir -p .github/workflows
cp ci/workflows/*.yml .github/workflows/
git add .github/workflows && git commit -m "Activate PROSM Time pipelines" && git push
```

Nothing else changes: the files are final and need no editing.
