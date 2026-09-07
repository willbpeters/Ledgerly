import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./queries";
import { buildPositions, aggregateHoldings } from "../domain/positions";
import { totalCash } from "../domain/cash";

export function useRefreshPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const updated = await api.prices.refresh();
      await qc.invalidateQueries({ queryKey: keys.latest });
      await qc.invalidateQueries({ queryKey: keys.previous });

      // recompute total value and record today's snapshot
      const [txns, securities, latest] = await Promise.all([
        api.transactions.list(), api.securities.list(), api.prices.latest(),
      ]);
      const holdings = aggregateHoldings(buildPositions(txns, new Map(latest)), securities);
      const invested = holdings.reduce((s, h) => s + h.marketValue, 0);
      const total = invested + totalCash(txns);
      await api.snapshots.record(new Date().toISOString().slice(0, 10), total);
      await qc.invalidateQueries({ queryKey: keys.snapshots });
      return updated;
    },
  });
}
