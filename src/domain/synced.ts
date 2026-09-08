import type { Position } from "./positions";
import type { Account, SyncedHolding, Transaction } from "./types";

/** Turn SimpleFIN holdings into Positions. Uses our latest price when we have
 *  one, otherwise the price implied by SimpleFIN's market value. */
export function syncedPositions(rows: SyncedHolding[], latestPrices: Map<number, number>): Position[] {
  return rows
    .filter((r) => r.shares > 0)
    .map((r) => {
      const implied = r.market_value / r.shares;
      const lastPrice = latestPrices.get(r.security_id) ?? implied;
      const marketValue = r.shares * lastPrice;
      return {
        account_id: r.account_id, security_id: r.security_id,
        shares: r.shares, avgCost: r.cost_basis / r.shares, costBasis: r.cost_basis,
        lastPrice, marketValue, unrealized: marketValue - r.cost_basis, realized: 0,
      };
    });
}

/** Synced accounts take their cash from SimpleFIN; manual accounts from transactions. */
export function mergeCash(txnCash: Map<number, number>, accounts: Account[]): Map<number, number> {
  const out = new Map(txnCash);
  for (const a of accounts) {
    if (a.source === "simplefin") out.set(a.id, a.synced_balance ?? 0);
  }
  return out;
}

/** Transactions that belong to manual accounts only. */
export function manualOnly(txns: Transaction[], accounts: Account[]): Transaction[] {
  const synced = new Set(accounts.filter((a) => a.source === "simplefin").map((a) => a.id));
  return txns.filter((t) => !synced.has(t.account_id));
}
