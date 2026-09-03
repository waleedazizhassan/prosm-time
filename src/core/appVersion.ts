import packageJson from "../../package.json";

// PROSM Time - § live UX review, user-directed: "write the version
// number in the appropriate places" (replacing the now-removed splash
// screen). Single source of truth (package.json's own version) rather
// than a second, hand-maintained constant that could drift from it.
export const APP_VERSION: string = packageJson.version;
