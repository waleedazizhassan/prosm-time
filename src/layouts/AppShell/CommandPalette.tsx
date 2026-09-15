import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { NAV_ITEMS } from "./navigation";
import styles from "./CommandPalette.module.css";

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone/.test(navigator.platform ?? "");
}

// PROSM Time - § user-directed, 2026-09-15 ("عايز توحيد للهيدر لكل
// المنتجات... زراير الاسم والداشبورد والبحث"): PROSM Platform's own
// Header has a real Ctrl+K search over its pages/work papers/media/
// commands (CommandPalette.jsx) - this app had no search at all.
// Ported the same trigger+overlay shape/sizing exactly (same CSS
// values, same keyboard model) but scoped to what actually exists
// here: this app's own NAV_ITEMS, filtered by the exact same
// permission/ownerOnly/hiddenFromOwner rules Sidebar.tsx already
// applies - no dynamic external sources (Work Papers/Media Links are
// Platform-specific concepts with no equivalent here), matching the
// user's own "regardless of the centers/capabilities" framing - only
// the FORMAT is unified, not Platform's specific feature set.
function CommandPalette() {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const { hasPermission, profile } = useAuth();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Same visibility rule Sidebar.tsx already applies - never a second,
  // parallel authorization concept for what shows up in search.
  const pages = useMemo(
    () =>
      NAV_ITEMS.filter(
        (item) =>
          (item.requiredPermission === null || hasPermission(item.requiredPermission)) &&
          (!item.ownerOnly || profile?.isOwner) &&
          (!item.hiddenFromOwner || !profile?.isOwner),
      ).map((item) => ({ id: item.id, title: t(item.labelKey), path: item.path, Icon: item.icon })),
    [hasPermission, profile?.isOwner, t],
  );

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
      if (modifierPressed && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.key === "Escape" && open) closePalette();
    };
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, [open, openPalette, closePalette]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages.filter((page) => !q || page.title.toLowerCase().includes(q));
  }, [pages, query]);

  const activate = useCallback(
    (path: string) => {
      closePalette();
      navigate(path);
    },
    [closePalette, navigate],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && results[activeIndex]) {
      activate(results[activeIndex].path);
    }
  };

  return (
    <>
      <button ref={triggerRef} type="button" className={styles.trigger} onClick={openPalette} aria-label={t("commandPalette.open")}>
        <Search size={14} />
        <span className={styles.triggerLabel}>{t("commandPalette.placeholder")}</span>
        <span className={styles.triggerShortcut}>{isMac() ? "⌘K" : "Ctrl K"}</span>
      </button>

      {open
        ? createPortal(
            <div className={styles.overlay} onClick={closePalette}>
              <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("commandPalette.open")} onClick={(event) => event.stopPropagation()}>
                <div className={styles.searchRow}>
                  <Search size={16} className={styles.searchIcon} />
                  <input
                    ref={inputRef}
                    className={styles.searchInput}
                    placeholder={t("commandPalette.placeholder")}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActiveIndex(0);
                    }}
                    onKeyDown={handleInputKeyDown}
                  />
                  <kbd className={styles.escHint}>Esc</kbd>
                </div>

                <div className={styles.results}>
                  {results.length === 0 ? (
                    <div className={styles.empty}>{t("commandPalette.noResults")}</div>
                  ) : (
                    <div className={styles.group}>
                      <div className={styles.groupLabel}>{t("commandPalette.categories.pages")}</div>
                      {results.map((page, index) => (
                        <button
                          type="button"
                          key={page.id}
                          className={`${styles.result} ${index === activeIndex ? styles.resultActive : ""}`}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => activate(page.path)}
                        >
                          <page.Icon size={15} className={styles.resultIcon} />
                          <span className={styles.resultText}>
                            <span className={styles.resultTitle}>{page.title}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default memo(CommandPalette);
