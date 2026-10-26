import { useEffect, useRef } from "react";
import { useSimplefinStatus, useSimplefinSync } from "./queries";

/**
 * Sync the bank connection once per launch, as soon as the status says one is
 * connected, so balances are current without a trip to the Sync button. Runs
 * quietly: a failure (offline, SimpleFIN down) leaves the last-synced time on
 * the command bar as it was, and the Sync button is still there to retry.
 */
export function useSimplefinAutoSync() {
  const { data: status } = useSimplefinStatus();
  const sync = useSimplefinSync();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !status?.connected) return;
    started.current = true;
    sync.mutateAsync().catch(() => {});
    // sync.mutateAsync is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected]);
}
