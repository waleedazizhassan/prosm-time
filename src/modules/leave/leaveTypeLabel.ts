import type { TFunction } from "i18next";

// v2.3.43 step 7: a built-in leave type has a translated name; one the Owner
// added (or renamed) shows its own name.
export default function leaveTypeLabel(t: TFunction, key: string, name?: string | null): string {
  return t(`leave:types.${key}`, { defaultValue: name ?? key });
}
