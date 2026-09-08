import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./queries";
import { derivePortfolio } from "../domain/portfolio";

export function useRefreshPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const updated = await api.prices.refresh();
      await qc.invalidateQueries({ queryKey: keys.latest });
      await qc.invalidateQueries({ queryKey: keys.previous });

      // Recompute total value with the same derivation the screens use, then
      // record today's snapshot for the chart.
      const [txns, securities, accounts, latest, previous, synced] = await Promise.all([
        api.transactions.list(), api.securities.list(), api.accounts.list(),
        api.prices.latest(), api.prices.previous(), api.syncedHoldings.list(),
      ]);
      const { summary } = derivePortfolio({ txns, securities, accounts, latest, previous, synced });
      await api.snapshots.record(new Date().toISOString().slice(0, 10), summary.totalValue);
      await qc.invalidateQueries({ queryKey: keys.snapshots });
      return updated;
    },
  });
}
