// PROSM Time - the ISO timestamp release.yml's "test" job generates
// once per workflow run and threads into every builder job's own
// `npm run build` (android/windows/web) AND into the exact same
// release's public/latest-version.json - so a running client's own
// baked-in value and the manifest's `releasedAt` are always the same
// timestamp for the release that produced this specific build. Empty
// in local dev (no VITE_BUILD_RELEASED_AT set) - UpdateAvailableBanner
// treats that the same as "can't tell", never a false "update
// available".
export const BUILD_RELEASED_AT: string = import.meta.env.VITE_BUILD_RELEASED_AT ?? "";
