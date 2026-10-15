import { useEffect, useRef } from "react";
import {
  useBackfillPrices, usePriceHistoryDepth, useIndexDepth, useBackfillIndices,
} from "./queries";
import { MIN_HISTORY_DAYS } from "../domain/risk";

/**
 * Re-exported so callers in the data layer keep their import, while the
 * threshold itself is defined once, in the maths that depends on it.
 */
export { MIN_HISTORY_DAYS };

/**
 * Whether to download price history. `depth` is the least-covered holding's
 * count of closes; `undefined` means the query has not answered yet, and
 * backfilling then would re-download on every launch. `lastTried` is the depth
 * the previous attempt started from: a ticker Yahoo cannot price leaves the
 * depth where it was, and trying that same depth again would loop.
 */
export function shouldBackfill(depth: number | undefined, lastTried: number | null = null): boolean {
  if (depth === undefined || depth === lastTried) return false;
  return depth < MIN_HISTORY_DAYS;
}

/**
 * Fill in price history whenever a holding is missing it: at launch, and again
 * after a sync brings in a new account (the sync refreshes the depth). The
 * backfill fetches only the securities still short, so this costs one request
 * per new holding, not one per holding — keep it off the polling timer all the
 * same.
 */
export function usePriceHistory() {
  const { data: depth } = usePriceHistoryDepth();
  const { data: indexDepth } = useIndexDepth();
  const backfill = useBackfillPrices();
  const backfillIndices = useBackfillIndices();
  const lastTried = useRef<number | null>(null);
  const startedIndices = useRef(false);

  useEffect(() => {
    if (backfill.isPending || !shouldBackfill(depth, lastTried.current)) return;
    lastTried.current = depth ?? null;
    // Offline or rate-limited is not fatal: the risk card says what is missing.
    backfill.mutateAsync().catch(() => {});
    // backfill.mutateAsync is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  useEffect(() => {
    if (startedIndices.current || !shouldBackfill(indexDepth)) return;
    startedIndices.current = true;
    backfillIndices.mutateAsync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexDepth]);
}
