import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search } from "lucide-react";

import styles from "./Dropdown.module.css";

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  id?: string;
  name?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  // the trigger's own look (an input, a compact filter, a menu field)
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

// a long list (people, sites) gets a search box
const SEARCH_FROM = 9;

// Owner 2026-10-26 ("in the lists that open, the name shows late or not at
// all"): the browser's own drop-down list is drawn by the browser - Firefox
// on Windows drew it white under the app's light text. The app draws the
// list itself, in its own colours, the same on every browser and phone.
export default function Dropdown({ id, name, value, options, onChange, disabled = false, className, style, ariaLabel }: DropdownProps) {
  const { t } = useTranslation("common");
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});

  const selected = options.find((option) => option.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? options.filter((option) => option.label.toLocaleLowerCase().includes(q)) : options;
  }, [options, query]);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (option: DropdownOption | undefined) => {
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    close();
  };
  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  // the list sits under the field (above it near the bottom of the screen),
  // fixed to the screen so a dialog or a table never cuts it off; it follows
  // the field when the page scrolls or the screen changes size (a phone's
  // keyboard opening for the search box) instead of closing
  const position = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const up = below < 240 && rect.top > below;
    const width = Math.max(rect.width, 176);
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.min(Math.max(8, getComputedStyle(trigger).direction === "rtl" ? rect.right - width : rect.left), viewport - width - 8);
    setPlace({
      left,
      width,
      maxHeight: Math.max(120, Math.min(320, (up ? rect.top : below) - 12)),
      ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  };

  useLayoutEffect(() => {
    if (open) position();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (searchRef.current ?? listRef.current)?.focus({ preventScroll: true });
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const moved = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) position();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  // keep the highlighted row in view
  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const onTriggerKey = (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openList();
    }
  };
  const onListKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(shown.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home" && !searchRef.current) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && !searchRef.current) {
      event.preventDefault();
      setActive(shown.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    } else if (!searchRef.current && event.key.length === 1) {
      // type to jump, as in the browser's own list
      const key = event.key.toLocaleLowerCase();
      const next = shown.findIndex((option, index) => index > active && option.label.toLocaleLowerCase().startsWith(key));
      const first = shown.findIndex((option) => option.label.toLocaleLowerCase().startsWith(key));
      if (next >= 0 || first >= 0) setActive(next >= 0 ? next : first);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        name={name}
        type="button"
        className={[styles.trigger, className].filter(Boolean).join(" ")}
        style={style}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
      >
        <span className={styles.value}>{selected?.label ?? ""}</span>
        <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            // a click in the list is not a click outside a menu the field sits in
            <div ref={panelRef} className={styles.panel} style={place} onKeyDown={onListKey} onMouseDown={(event) => event.stopPropagation()}>
              {options.length >= SEARCH_FROM ? (
                <label className={styles.search}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    placeholder={t("dropdown.search")}
                    aria-label={t("dropdown.search")}
                    aria-controls={listId}
                  />
                </label>
              ) : null}
              <ul ref={listRef} id={listId} role="listbox" tabIndex={-1} className={styles.list} aria-label={ariaLabel} aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}>
                {shown.length === 0 ? <li className={styles.empty}>{t("dropdown.noMatch")}</li> : null}
                {shown.map((option, index) => (
                  <li
                    key={option.value}
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    className={[styles.option, index === active ? styles.active : "", option.value === value ? styles.selected : ""].filter(Boolean).join(" ")}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
