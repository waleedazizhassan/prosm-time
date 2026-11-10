import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useFeedback } from "../../core/context/FeedbackContext";
import { errorKindFor, type StateKind } from "../../core/utils/errorKind";
import { errorFixFor } from "../../core/utils/errorFix";
import { STATE_ART } from "./stateArt";
import styles from "./ErrorText.module.css";

// PROSM Time - § live UX review, user-directed: "a full error-message
// audit." Every session-less auth page (Login, Activation, etc.) has
// always rendered its error through AuthLayout.module.css's own
// .errorText class; every other page instead hand-rolled the exact
// same look (`<p style={{ color: "var(--brand-danger)", fontSize:
// "var(--font-sm)" }}>`) inline at ~30 call sites - identical in
// substance, just never extracted. This is that extraction: renders
// nothing for an empty/falsy message, so call sites drop their own
// `{error ? ... : null}` guard too.
//
// v2.3.43 step 21 (owner 2026-10-26): with a small picture that fits the
// problem - no permission, location, camera, not found, session, no
// connection - taken from the server's own error (humanizeBackendError
// remembers it for the translated text), or given by the page as `kind`.
//
// Owner 2026-11-10: every message is one box in the middle of the screen (FeedbackDialog) with OK;
// a page keeps writing <ErrorText>{error}</ErrorText> and the box opens whenever the message changes.
// Outside the app's provider (tests, isolated renders) the message stays inline as before.
export default function ErrorText({ children, kind }: { children: ReactNode; kind?: StateKind }) {
  const feedback = useFeedback();
  const { t } = useTranslation();
  const text = typeof children === "string" || typeof children === "number" ? String(children) : null;
  const known = text ? errorKindFor(text) : null;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  // without a connection, that is almost always the real cause
  const resolved: StateKind = offline ? "offline" : kind ?? known ?? "error";

  useEffect(() => {
    if (feedback && text) feedback.show({ tone: "error", text, kind: resolved, fix: errorFixFor(resolved, text, t) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback, text]);

  if (!children) return null;
  if (feedback && text) return null;
  return (
    <div className={styles.message} role="alert" data-kind={resolved}>
      <img src={STATE_ART[resolved]} alt="" className={styles.art} />
      <p className={styles.text}>{children}</p>
    </div>
  );
}
