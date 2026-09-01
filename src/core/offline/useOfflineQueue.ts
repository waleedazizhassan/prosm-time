import { useEffect, useState } from "react";
import OfflineQueueService, { type OfflineQueueItem } from "./OfflineQueueService";

// PROSM Time WP-15 - subscribes to the offline queue and keeps
// attempting a flush (mount, reconnect, and a light interval
// fallback) for as long as a component using this hook is mounted.
export function useOfflineQueue(userId: string | undefined): OfflineQueueItem[] {
  const [items, setItems] = useState<OfflineQueueItem[]>([]);

  useEffect(() => {
    const unsubscribe = OfflineQueueService.subscribe((allItems) => {
      setItems(userId ? allItems.filter((item) => item.userId === userId) : []);
    });
    return unsubscribe;
  }, [userId]);

  useEffect(() => {
    const attemptFlush = () => {
      OfflineQueueService.flush();
    };
    attemptFlush();
    window.addEventListener("online", attemptFlush);
    const interval = setInterval(attemptFlush, 30000);
    return () => {
      window.removeEventListener("online", attemptFlush);
      clearInterval(interval);
    };
  }, []);

  return items;
}
