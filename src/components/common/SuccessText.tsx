import { useEffect, type ReactNode } from "react";

import { useFeedback } from "../../core/context/FeedbackContext";

// Owner 2026-11-10: a success says so in the same box as an error (FeedbackDialog), with OK.
// <SuccessText>{message}</SuccessText> opens it whenever the message appears or changes; outside the
// app's provider it stays a short green line.
export default function SuccessText({ children, title }: { children: ReactNode; title?: string }) {
  const feedback = useFeedback();
  const text = typeof children === "string" || typeof children === "number" ? String(children) : null;

  useEffect(() => {
    if (feedback && text) feedback.show({ tone: "success", text, title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback, text]);

  if (!children) return null;
  if (feedback && text) return null;
  return (
    <p role="status" style={{ margin: "var(--space-2) 0", color: "var(--status-success-text)", fontSize: "var(--font-sm)", fontWeight: 600 }}>
      {children}
    </p>
  );
}
