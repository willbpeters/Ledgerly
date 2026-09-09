import { buildPositions, aggregateHoldings } from "./positions";
import { buildSummary } from "./summary";
import { allocationByType, allocationByAccount } from "./allocation";
import { cashByAccount } from "./cash";
import { syncedPositions, mergeCash, manualOnly } from "./synced";
import type { Account, Holding, Security, SyncedHolding, Transaction, PortfolioSummary, AllocationSlice } from "./types";

export interface PortfolioInputs {
  txns: Transaction[]; securities: Security[]; accounts: Account[];
  latest: [number, number][]; previous: [number, number][]; synced: SyncedHolding[];
}

export interface AccountBreakdown {
  account: Account; holdings: Holding[]; holdingsValue: number; cash: number; value: number;
}

export interface Portfolio {
  holdings: Holding[]; summary: PortfolioSummary; cash: number; byAccount: AccountBreakdown[];
  allocationType: AllocationSlice[]; allocationAccount: AllocationSlice[];
  accountValues: Map<number, number>; accounts: Account[];
}

/** The single derivation point: every screen and the snapshot recorder use this. */
export function derivePortfolio(i: PortfolioInputs): Portfolio {
  // Hidden accounts are dropped here rather than in each screen, so no two
  // views can disagree about what is excluded. Their transactions and synced
  // holdings go with them — filtering the account list alone would leave a
  // hidden manual account's transactions still counting toward cash.
  const accounts = i.accounts.filter((a) => !a.hidden);
  const visible = new Set(accounts.map((a) => a.id));
  const txns = i.txns.filter((t) => visible.has(t.account_id));
  const syncedHoldings = i.synced.filter((h) => visible.has(h.account_id));

  const latestMap = new Map<number, number>(i.latest);
  const prevMap = new Map<number, number>(i.previous);
  const manualTxns = manualOnly(txns, accounts);

  const positions = [
    ...buildPositions(manualTxns, latestMap),
    ...syncedPositions(syncedHoldings, latestMap),
  ];
  const holdings = aggregateHoldings(positions, i.securities);

  const cashMap = mergeCash(cashByAccount(manualTxns), accounts);
  // A credit card's balance is money owed, not cash you could spend, so the two
  // are totalled separately even though both land in the net-worth figure.
  const isCredit = new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id));
  let cash = 0;
  let liabilities = 0;
  for (const [accountId, value] of cashMap) {
    if (isCredit.has(accountId)) liabilities += value;
    else cash += value;
  }
  const summary = buildSummary(holdings, cash, prevMap, liabilities);

  const accountValues = new Map<number, number>(cashMap);
  for (const p of positions) accountValues.set(p.account_id, (accountValues.get(p.account_id) ?? 0) + p.marketValue);

  const byAccount: AccountBreakdown[] = accounts.map((a) => {
    const accHoldings = aggregateHoldings(positions.filter((p) => p.account_id === a.id), i.securities);
    const holdingsValue = accHoldings.reduce((s, h) => s + h.marketValue, 0);
    return { account: a, holdings: accHoldings, holdingsValue, cash: cashMap.get(a.id) ?? 0, value: accountValues.get(a.id) ?? 0 };
  });

  return {
    holdings, summary, cash, byAccount,
    allocationType: allocationByType(holdings, cash),
    allocationAccount: allocationByAccount(accountValues, accounts),
    accountValues, accounts,
  };
}
