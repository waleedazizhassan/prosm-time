#!/usr/bin/env bash
# 2026-11-09 (owner): Android apps released before the Google Play flavour (2.3.71 and older) still
# read app-releases/latest-version.json and show "update available" when it moves. Run this ONLY
# after the new bundle is live on Google Play, so the message appears when Play really has it.
# usage: scripts/publish-play-manifest.sh <version>     e.g. scripts/publish-play-manifest.sh 2.3.72
# Needs the Supabase CLI logged in to the PROSM Time project.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$1"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<JSON
{
  "version": "${VERSION}",
  "releasedAt": "${RELEASED_AT}",
  "downloads": {
    "windows": "https://time.prosm.net",
    "android": "https://play.google.com/store/apps/details?id=net.prosm.time",
    "web": "https://time.prosm.net"
  }
}
JSON

KEY="$(npx supabase projects api-keys --project-ref wcfdhsxzeryqwpmftgay -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(k=>k.name==="service_role").api_key))')"
curl -sf -X POST "https://wcfdhsxzeryqwpmftgay.supabase.co/storage/v1/object/app-releases/latest-version.json" \
  -H "Authorization: Bearer ${KEY}" -H "x-upsert: true" -H "Content-Type: application/json" -H "cache-control: max-age=60" \
  --data-binary "@${TMP}" > /dev/null
echo "latest-version.json now announces ${VERSION} to Android apps from before the Google Play flavour."
