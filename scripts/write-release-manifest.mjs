// v2.3.43 step 19 (item 12): the release manifest installed clients poll,
// written from ONE source - the release version in package.json (set by the
// workflow before any build) and the run's single releasedAt. Every job that
// builds (the APK, the web build) writes it before `npm run build`, so the
// copy inside each build and the published copy always carry the same
// version (APK 2.3.42 once shipped 2.3.41's manifest).
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.RELEASE_VERSION || JSON.parse(readFileSync("package.json", "utf8")).version;
const releasedAt = process.env.RELEASED_AT || process.env.VITE_BUILD_RELEASED_AT;
if (!releasedAt) {
  console.error("write-release-manifest: RELEASED_AT is required (the run's single timestamp).");
  process.exit(1);
}
const web = "https://time.prosm.net";
const manifest = {
  version,
  releasedAt,
  downloads: {
    // Older desktop installs are sent to the web version (owner 2026-10-20).
    windows: web,
    android: `https://wcfdhsxzeryqwpmftgay.supabase.co/storage/v1/object/public/app-releases/PROSM-Time-v${version}.apk`,
    web,
  },
};
writeFileSync("public/latest-version.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
