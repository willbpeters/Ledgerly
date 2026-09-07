import { useMemo } from "react";
import { useTransactions, useSecurities, useAccounts, useLatestPrices, usePreviousPrices } from "./queries";
import { buildPositions, aggregateHoldings, accountMarketValues } from "../domain/positions";
import { buildSummary } from "../domain/summary";
import { allocationByType, allocationByAccount } from "../domain/allocation";
import { totalCash } from "../domain/cash";

export function usePortfolio() {
  const { data: txns = [], isLoading: l1 } = useTransactions();
  const { data: securities = [], isLoading: l2 } = useSecurities();
  const { data: accounts = [], isLoading: l3 } = useAccounts();
  const { data: latest = [], isLoading: l4 } = useLatestPrices();
  const { data: previous = [], isLoading: l5 } = usePreviousPrices();

  return useMemo(() => {
    const latestMap = new Map<number, number>(latest);
    const prevMap = new Map<number, number>(previous);
    const positions = buildPositions(txns, latestMap);
    const holdings = aggregateHoldings(positions, securities);
    const cash = totalCash(txns);
    const summary = buildSummary(holdings, cash, prevMap);
    const acctValues = accountMarketValues(positions, txns);
    return {
      holdings, summary, cash,
      allocationType: allocationByType(holdings, cash),
      allocationAccount: allocationByAccount(acctValues, accounts),
      accountValues: acctValues, accounts,
      isLoading: l1 || l2 || l3 || l4 || l5,
    };
  }, [txns, securities, accounts, latest, previous, l1, l2, l3, l4, l5]);
}
