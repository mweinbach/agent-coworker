import { useCallback, useMemo, useState } from "react";
import type { FeedItem } from "../../app/types";
import {
  type FeedDerivationWindowState,
  resolveFeedDerivationVisibleCount,
  selectFeedDerivationWindow,
} from "./feedWindow";

const DEFAULT_VISIBLE_COUNT = 80;
const DEFAULT_EXPAND_BATCH = 40;

export function useFeedDerivationWindow(threadId: string | null, derivationFeed: FeedItem[]) {
  const [windows, setWindows] = useState<Map<string, FeedDerivationWindowState>>(() => new Map());
  const visibleCount = resolveFeedDerivationVisibleCount(
    threadId ? windows.get(threadId) : undefined,
    derivationFeed.length,
    DEFAULT_VISIBLE_COUNT,
  );
  const windowedSourceFeed = useMemo(
    () => selectFeedDerivationWindow(derivationFeed, visibleCount),
    [derivationFeed, visibleCount],
  );
  const expandOlderFeed = useCallback(() => {
    if (!threadId) return;
    setWindows((current) => {
      const next = new Map(current);
      next.set(threadId, {
        feedLength: derivationFeed.length,
        visibleCount: Math.min(derivationFeed.length, visibleCount + DEFAULT_EXPAND_BATCH),
      });
      return next;
    });
  }, [derivationFeed.length, threadId, visibleCount]);
  const showAllOlderFeed = useCallback(() => {
    if (!threadId) return;
    setWindows((current) => {
      const next = new Map(current);
      next.set(threadId, {
        feedLength: derivationFeed.length,
        visibleCount: derivationFeed.length,
      });
      return next;
    });
  }, [derivationFeed.length, threadId]);

  return { expandOlderFeed, showAllOlderFeed, windowedSourceFeed };
}
