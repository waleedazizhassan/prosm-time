import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChecklistItem } from "../../core/repositories/ShiftExtrasRepository";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";

// docs/IDEAS.md 6: before clocking out, the site's checklist. What is not ticked is
// recorded as not done; the clock-out is never blocked by it.
export default function ShiftChecklistModal({ items, onCancel, onDone }: { items: ChecklistItem[]; onCancel: () => void; onDone: (doneIds: string[]) => void }) {
  const { t } = useTranslation("dashboard");
  const [done, setDone] = useState<string[]>([]);

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={t("checklist.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => onDone(done)}>{done.length === items.length ? t("checklist.continue") : t("checklist.continueIncomplete")}</Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {items.map((item) => (
          <label key={item.id} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start", fontSize: "var(--font-sm)" }}>
            <input type="checkbox" checked={done.includes(item.id)} onChange={(event) => setDone((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))} />
            {item.label}
          </label>
        ))}
      </div>
    </Modal>
  );
}
