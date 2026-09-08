export type AccountType = "brokerage" | "cash";
export type SecurityType = "stock" | "etf";
export type TxnType =
  | "buy" | "sell" | "dividend" | "deposit" | "withdrawal" | "fee" | "interest";

export type AccountSource = "manual" | "simplefin";
export interface Account {
  id: number; name: string; type: AccountType;
  institution: string | null; currency: string; created_at: string;
  source: AccountSource; external_id: string | null;
  synced_balance: number | null; last_synced_at: string | null;
}
export interface Security {
  id: number; ticker: string; name: string | null;
  type: SecurityType; currency: string;
}
export interface Transaction {
  id: number; account_id: number; security_id: number | null;
  type: TxnType; date: string; quantity: number; price: number;
  amount: number; fees: number; note: string | null;
}
export interface Price { security_id: number; date: string; close: number; source: string; }
export interface Snapshot { date: string; total_value: number; }

/** A holding aggregated across accounts, by security. */
export interface Holding {
  security_id: number; ticker: string; type: SecurityType;
  shares: number; avgCost: number; costBasis: number;
  lastPrice: number; marketValue: number;
  unrealized: number; unrealizedPct: number; realized: number;
}
export interface PortfolioSummary {
  totalValue: number; investedValue: number; cash: number;
  totalCostBasis: number; unrealized: number; unrealizedPct: number;
  realized: number; dayChange: number; dayChangePct: number;
}
export interface AllocationSlice { label: string; value: number; pct: number; }
export interface SeriesPoint { date: string; value: number; }

export interface SyncedHolding {
  id: number; account_id: number; security_id: number;
  shares: number; cost_basis: number; market_value: number; as_of: string;
}
export interface SyncReport {
  accounts_synced: number; holdings_synced: number; holdings_skipped: number; errors: string[];
}
export interface SimplefinStatus { connected: boolean; last_synced_at: string | null; }
