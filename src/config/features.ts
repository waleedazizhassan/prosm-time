// Features that exist in the code but are hidden from the app. Turning one
// back on is this single line - nothing was deleted.
export const FEATURES = {
  // Owner 2026-10-13: hide every integration (payroll integrations and the
  // API keys page) without removing them. The server side is unchanged:
  // existing API keys - used by PROSM Projects and PROSM Finance - keep
  // working; only managing keys from the app is hidden.
  // Owner 2026-11-09: the API is on and shown again; the plan that carries it is decided
  // in the packages session (every plan includes it for now, migration 20261109210000).
  integrations: true,
  // Owner 2026-10-21 (review: things we don't need): projects inside a site
  // are hidden until a client asks for them. Nothing is deleted.
  projects: false,
  // Owner 2026-11-13 ("finish it, test everything, then release the web"): PROSM Connect is on - shown to the
  // organisations whose plan has it (Business and up, trials, existing customers). VITE_CONNECT=off hides it.
  connect: import.meta.env.VITE_CONNECT !== "off",
} as const;
