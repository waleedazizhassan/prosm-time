#!/usr/bin/env bash
# The Google Play bundle: the play flavor, R8 on, no self-update code.
# usage: scripts/build-play-aab.sh <versionName> <versionCode>
# Output: android/app/build/outputs/bundle/playRelease/app-play-release.aab,
# mapping/playRelease/mapping.txt and native-debug-symbols/playRelease/.
# Needs android/keystore.properties and JAVA_HOME. No file it changes is kept.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_NAME="$1"
VERSION_CODE="$2"

export VITE_SUPABASE_URL="https://wcfdhsxzeryqwpmftgay.supabase.co"
export VITE_SUPABASE_ANON_KEY="sb_publishable_HIckVV9KFC3f6xhq6VS5RQ_KGybZ6bt"
export VITE_FIREBASE_CONFIGURED=true
export VITE_DISTRIBUTION=play
export VITE_BUILD_RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
# Deliberately no VITE_UPDATE_MANIFEST_URL: this build must not know it.
unset VITE_UPDATE_MANIFEST_URL || true

restore() { git checkout -- android/app/build.gradle public/latest-version.json 2>/dev/null || true; }
trap restore EXIT

node scripts/write-release-manifest.mjs > /dev/null
npm run build:obfuscated > /dev/null

# The update manifest must not ship in this bundle.
rm -f dist/latest-version.json
if grep -rqE 'latest-version\.json|PROSM-Time\.apk|app-releases' dist --include='*.js'; then
  echo "self-update code found in the Play bundle" >&2
  exit 1
fi

npx cap sync android > /dev/null
sed -i "s/versionCode 3\$/versionCode ${VERSION_CODE}/; s/versionName \"2.3.2\"/versionName \"${VERSION_NAME}\"/" android/app/build.gradle
(cd android && ./gradlew --no-daemon :app:bundlePlayRelease -PprosmR8=true)
ls -la android/app/build/outputs/bundle/playRelease/ android/app/build/outputs/mapping/playRelease/mapping.txt
