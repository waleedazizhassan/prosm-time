import type { ReactNode } from "react";

// PROSM Time - § live UX review, user-directed: "a full error-message
// audit." Every session-less auth page (Login, Activation, etc.) has
// always rendered its error through AuthLayout.module.css's own
// .errorText class; every other page instead hand-rolled the exact
// same look (`<p style={{ color: "var(--brand-danger)", fontSize:
// "var(--font-sm)" }}>`) inline at ~30 call sites - identical in
// substance, just never extracted. This is that extraction: renders
// nothing for an empty/falsy message, so call sites drop their own
// `{error ? ... : null}` guard too.
export default function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{children}</p>;
}
