#!/usr/bin/env bash
# The APK kill switch's owner-run step, once Google approves production:
#   1. set apk_distribution_enabled = false in the Platform Manager
#   2. run this, so the release workflow stops publishing APKs too.
# Reverse it with: gh variable set APK_DISTRIBUTION_ENABLED --body true
set -euo pipefail
gh variable set APK_DISTRIBUTION_ENABLED --body false
echo "The next release builds the web only; no APK and no latest-version.json."
