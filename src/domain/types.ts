export type AccountType = "brokerage" | "cash" | "credit";
export type SecurityType = "stock" | "etf";
export type TxnType =
  | "buy" | "sell" | "dividend" | "deposit" | "withdrawal" | "fee" | "interest";

export type AccountSource = "manual" | "simplefin";
export interface Account {
  id: number; name: string; type: AccountType;
  institution: string | null; currency: string; created_at: string;
  source: AccountSource; external_id: string | null;
  synced_balance: number | null; last_synced_at: string | null;
  /** Hidden accounts are left out of every total, chart and list. */
  hidden: boolean;
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
  /** Money owed on credit accounts, as a negative number (0 when none). */
  liabilities: number;
  totalCostBasis: number; unrealized: number; unrealizedPct: number;
  realized: number; dayChange: number; dayChangePct: number;
}
export interface AllocationSlice { label: string; value: number; pct: number; }
export interface SeriesPoint { date: string; value: number; }

/**
 * One reconstructed day: net worth, and the invested part of it.
 *
 * A separate interface rather than an optional field on `SeriesPoint`, because
 * optional means a caller can forget to set it and plot `undefined` as a gap.
 */
export interface ValuePoint extends SeriesPoint {
  /** Holdings only — unmoved by deposits, withdrawals or card balances. */
  invested: number;
}

export interface SyncedHolding {
  id: number; account_id: number; security_id: number;
  shares: number; cost_basis: number; market_value: number; as_of: string;
}
export interface SyncReport {
  accounts_synced: number; holdings_synced: number; holdings_skipped: number;
  transactions_added: number; transactions_updated: number;
  /** SimpleFIN accounts dropped because the feed no longer carries them. */
  accounts_removed: number;
  errors: string[];
}
export interface SimplefinStatus { connected: boolean; last_synced_at: string | null; }

export type CategoryKind = "spending" | "income" | "transfer";
export interface Category {
  id: number; name: string; kind: CategoryKind;
  colour: string; sort: number; is_builtin: boolean;
}
export interface BankTransaction {
  id: number; account_id: number; external_id: string;
  posted: string; amount: number; description: string;
  payee: string | null; memo: string | null; mcc: string | null;
  pending: boolean; category_id: number | null;
  category_source: "auto" | "manual";
  /** False until the owner has approved it or chosen a category. */
  reviewed: boolean;
  /** The owner's note; Copilot's notes arrive with the import. */
  note: string | null;
  /** Left out of Spending and budgets (paid back); restorable. */
  removed: boolean;
}

/** What an import from Copilot would do. See `budget/copilot.rs`. */
export interface CopilotPlan {
  matches: { txn_id: number; category: string | null; note: string | null }[];
  additions: { external_id: string; posted: string; amount: number; name: string; category: string | null }[];
  skipped: { date: string; name: string; amount: number; account: string }[];
  /** Ledgerly rows Copilot does not have: usually deleted there after being paid back. */
  not_in_copilot: { txn_id: number; date: string; name: string; amount: number; account: string }[];
  pending_or_excluded: number;
  new_categories: { name: string; kind: string }[];
  rules: { pattern: string; category: string }[];
  /** Copilot account → the Ledgerly account it maps to. */
  accounts: [string, string][];
}
export interface CopilotCounts { matched: number; added: number; categories: number; rules: number; removed: number }
export interface CategoryRule {
  id: number; match_type: "payee" | "description" | "mcc";
  pattern: string; category_id: number; created_at: string;
}
export interface Budget {
  id: number; category_id: number; month: string | null; limit_amount: number;
}

/** A transaction on its way to the database, before it has an id. */
export interface NewTransaction {
  account_id: number; security_id: number | null; type: string; date: string;
  quantity: number; price: number; amount: number; fees: number; note: string | null;
}
/** An account on its way to the database, before it has an id. */
export interface NewAccount { name: string; type: string; institution: string | null; }

export interface NewsItem {
  security_id: number; title: string; summary: string | null; url: string;
  publisher: string | null; published: string; fetched_at: string;
}
export interface EarningsEvent {
  security_id: number; fiscal_period: string | null; report_date: string;
  eps_actual: number | null; eps_estimate: number | null; estimate_count: number | null;
}
export interface SecurityProfile {
  security_id: number; long_name: string | null; sector: string | null;
  quote_type: string | null; tracks: string | null;
}
export interface IndexQuote { symbol: string; label: string; latest: number; previous: number; }
export interface MarketRefreshReport {
  news_added: number; profiles_updated: number; earnings_updated: number;
  indices_updated: number; errors: string[];
}

/** Two renderings of the SimpleFIN diagnostic sample: what to show, and what
 *  is safe to put on the clipboard. */
export type SimplefinSample = { raw: string; redacted: string };

export type BackupKind = "daily" | "pre-migration" | "pre-restore" | "manual";

export interface BackupEntry {
  file_name: string; path: string;
  /** Local date and time, `YYYY-MM-DD` and `HH:MM:SS`. */
  date: string; time: string;
  kind: BackupKind; size: number;
}

export interface BackupAttempt {
  at: string; kind: BackupKind; file: string | null;
  error: string | null;
  /** The backup worked, but the extra-folder copy or pruning did not. */
  warning: string | null;
}

export interface BackupStatus {
  latest: BackupEntry | null;
  last_attempt: BackupAttempt | null;
  restore_error: string | null;
  extra_folder: string | null;
  backups_folder: string;
}
