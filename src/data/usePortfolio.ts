import { useMemo } from "react";
import { useTransactions, useSecurities, useAccounts, useLatestPrices, usePreviousPrices } from "./queries";
import { buildPositions, aggregateHoldings, accountMarketValues } from "../domain/positions";
import { buildSummary } from "../domain/summary";
import { allocationByType, allocationByAccount } from "../domain/allocation";
import { totalCash, cashByAccount } from "../domain/cash";
import type { Account, Holding } from "../domain/types";

export interface AccountBreakdown {
  account: Account;
  holdings: Holding[];
  holdingsValue: number; // sum of this account's holdings' market value
  cash: number;
  value: number;         // holdings + cash
}

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
    const cashMap = cashByAccount(txns);

    const byAccount: AccountBreakdown[] = accounts.map((a) => {
      const accHoldings = aggregateHoldings(positions.filter((p) => p.account_id === a.id), securities);
      const holdingsValue = accHoldings.reduce((s, h) => s + h.marketValue, 0);
      return {
        account: a,
        holdings: accHoldings,
        holdingsValue,
        cash: cashMap.get(a.id) ?? 0,
        value: acctValues.get(a.id) ?? 0,
      };
    });

    return {
      holdings, summary, cash, byAccount,
      allocationType: allocationByType(holdings, cash),
      allocationAccount: allocationByAccount(acctValues, accounts),
      accountValues: acctValues, accounts,
      isLoading: l1 || l2 || l3 || l4 || l5,
    };
  }, [txns, securities, accounts, latest, previous, l1, l2, l3, l4, l5]);
}
