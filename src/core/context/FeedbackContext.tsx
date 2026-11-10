import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { StateKind } from "../utils/errorKind";
import FeedbackDialog from "../../components/common/FeedbackDialog";

// Owner 2026-11-10: "every error or success message in one form across the app - a box in the middle
// of the screen that explains the problem or says it worked, with OK under it, or an action if there
// is one". ErrorText and SuccessText send their message here instead of showing it inline, so every
// page uses the same box without each page being rewritten.
export interface FeedbackMessage {
  tone: "error" | "success";
  text: string;
  kind?: StateKind;
  title?: string;
  action?: { label: string; onClick: () => void };
}

interface FeedbackApi {
  show: (message: FeedbackMessage) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<FeedbackMessage[]>([]);

  const show = useCallback((message: FeedbackMessage) => {
    setQueue((current) => {
      // the same message twice in a row is said once
      const last = current[current.length - 1];
      if (last && last.text === message.text && last.tone === message.tone) return current;
      return [...current, message];
    });
  }, []);

  const close = useCallback(() => setQueue((current) => current.slice(1)), []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      {queue[0] ? <FeedbackDialog message={queue[0]} onClose={close} /> : null}
    </FeedbackContext.Provider>
  );
}

/** null outside the provider (tests and isolated renders keep the inline message). */
export function useFeedback(): FeedbackApi | null {
  return useContext(FeedbackContext);
}
