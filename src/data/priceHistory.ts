import { useEffect, useRef } from "react";
import { useBackfillPrices, usePriceHistoryDepth } from "./queries";
import { MIN_HISTORY_DAYS } from "../domain/risk";

/**
 * Re-exported so callers in the data layer keep their import, while the
 * threshold itself is defined once, in the maths that depends on it.
 */
export { MIN_HISTORY_DAYS };

/**
 * Whether to download price history. `undefined` means the depth query has not
 * answered yet; backfilling then would re-download on every launch.
 */
export function shouldBackfill(depth: number | undefined): boolean {
  if (depth === undefined) return false;
  return depth < MIN_HISTORY_DAYS;
}

/**
 * Fill in price history once, when the database does not already have it.
 * Two years of daily closes is one request per security — the same cost as an
 * ordinary refresh — so this must not run on the polling timer.
 */
export function usePriceHistory() {
  const { data: depth } = usePriceHistoryDepth();
  const backfill = useBackfillPrices();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !shouldBackfill(depth)) return;
    started.current = true;
    // Offline or rate-limited is not fatal: the risk card says what is missing.
    backfill.mutateAsync().catch(() => {});
    // backfill.mutateAsync is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);
}
