// Features that exist in the code but are hidden from the app. Turning one
// back on is this single line - nothing was deleted.
export const FEATURES = {
  // Owner 2026-10-13: hide every integration (payroll integrations and the
  // API keys page) without removing them. The server side is unchanged:
  // existing API keys - used by PROSM Projects and PROSM Finance - keep
  // working; only managing keys from the app is hidden.
  integrations: false,
} as const;
