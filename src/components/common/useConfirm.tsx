import { useCallback, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import Button from "./Button";
import Modal from "./Modal";

// v2.3.43 step 21 (audit, visual consistency): a confirmation in the app's
// own dialog instead of the browser's window.confirm, which has its own
// look, ignores right-to-left and is plain in the Android app.
// const [confirm, confirmDialog] = useConfirm();  ...  if (!(await confirm(text))) return;
export default function useConfirm(): [(message: string) => Promise<boolean>, ReactElement | null] {
  const { t } = useTranslation("common");
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((text: string) => {
    resolver.current?.(false);
    setMessage(text);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setMessage(null);
  };

  const dialog =
    message === null ? null : (
      <Modal
        isOpen
        onClose={() => answer(false)}
        title={t("actions.confirm")}
        footer={
          <>
            <Button variant="ghost" onClick={() => answer(false)}>
              {t("actions.cancel")}
            </Button>
            <Button variant="danger" onClick={() => answer(true)}>
              {t("actions.confirm")}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--font-sm)", lineHeight: 1.7, color: "var(--text-primary)" }}>{message}</p>
      </Modal>
    );

  return [confirm, dialog];
}
