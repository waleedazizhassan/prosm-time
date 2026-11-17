import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import PeopleDirectoryRepository from "../../core/repositories/PeopleDirectoryRepository";

// Owner 2026-11-17: from one person's page to the next with a sideways swipe (and arrows on a computer) - in the
// people list's order, keeping the open tab. Follows the reading direction (Arabic: a swipe to the right is "next").
// A swipe that starts inside something that scrolls sideways itself (tabs, a table) is left to it.
export default function usePersonSwipe(userId: string | undefined) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { i18n } = useTranslation();
  const [ids, setIds] = useState<string[]>([]);
  const start = useRef<{ x: number; y: number; skip: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void PeopleDirectoryRepository.list().then((people) => {
      if (alive) setIds([...people].sort((a, b) => a.fullName.localeCompare(b.fullName, i18n.language)).map((p) => p.id));
    });
    return () => { alive = false; };
  }, [i18n.language]);

  const index = userId ? ids.indexOf(userId) : -1;
  const prevId = index > 0 ? ids[index - 1] : null;
  const nextId = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null;
  const go = (id: string | null) => {
    if (!id) return;
    const tab = searchParams.get("tab");
    navigate(`/people/${id}${tab ? `?tab=${tab}` : ""}`);
  };

  const scrollsSideways = (el: Element | null): boolean => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 2) return true;
    }
    return false;
  };

  const handlers = {
    onTouchStart: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      start.current = { x: touch.clientX, y: touch.clientY, skip: scrollsSideways(event.target as Element) };
    },
    onTouchEnd: (event: React.TouchEvent) => {
      const from = start.current;
      start.current = null;
      if (!from || from.skip) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      const rtl = i18n.dir() === "rtl";
      const towardsNext = rtl ? dx > 0 : dx < 0;
      go(towardsNext ? nextId : prevId);
    },
  };

  return { prevId, nextId, goPrev: () => go(prevId), goNext: () => go(nextId), handlers, position: index >= 0 ? `${index + 1}/${ids.length}` : "" };
}
