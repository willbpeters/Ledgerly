import { invoke } from "@tauri-apps/api/core";
import type {
  Account, Security, Transaction, Snapshot,
  SyncedHolding, SyncReport, SimplefinStatus, SimplefinSample,
  Category, BankTransaction, CategoryRule, Budget,
  NewAccount, NewTransaction,
  NewsItem, EarningsEvent, SecurityProfile, IndexQuote, MarketRefreshReport,
  BackupEntry, BackupAttempt, BackupStatus, CopilotPlan, CopilotCounts,
} from "../domain/types";

export type { NewAccount, NewTransaction };

export const api = {
  accounts: {
    list: () => invoke<Account[]>("accounts_list"),
    create: (account: NewAccount) => invoke<Account>("accounts_create", { account }),
    delete: (id: number) => invoke<void>("accounts_delete", { id }),
    setHidden: (id: number, hidden: boolean) => invoke<void>("accounts_set_hidden", { id, hidden }),
  },
  securities: {
    list: () => invoke<Security[]>("securities_list"),
    getOrCreate: (ticker: string, name: string | null, kind: string) =>
      invoke<Security>("securities_get_or_create", { ticker, name, kind }),
  },
  transactions: {
    list: () => invoke<Transaction[]>("transactions_list"),
    create: (txn: NewTransaction) => invoke<Transaction>("transactions_create", { txn }),
    createMany: (txns: NewTransaction[]) => invoke<number>("transactions_create_many", { txns }),
    delete: (id: number) => invoke<void>("transactions_delete", { id }),
  },
  prices: {
    latest: () => invoke<[number, number][]>("prices_latest"),
    previous: () => invoke<[number, number][]>("prices_previous"),
    setManual: (security_id: number, date: string, close: number) =>
      invoke<void>("prices_set_manual", { securityId: security_id, date, close }),
    refresh: () => invoke<number>("prices_refresh"), // added in Task 15
    /** Two years of closes for every security with fewer than `minDays`. */
    backfill: (minDays: number) => invoke<number>("prices_backfill", { minDays }),
    historyDepth: () => invoke<number>("prices_history_depth"),
    history: (from: string) => invoke<[number, string, number][]>("prices_history", { from }),
  },
  snapshots: {
    list: () => invoke<Snapshot[]>("snapshots_list"),
    record: (date: string, total_value: number) =>
      invoke<void>("snapshots_record", { date, totalValue: total_value }),
  },
  syncedHoldings: {
    list: () => invoke<SyncedHolding[]>("synced_holdings_list"),
  },
  market: {
    news: () => invoke<NewsItem[]>("market_news_list"),
    earnings: () => invoke<EarningsEvent[]>("market_earnings_list"),
    profiles: () => invoke<SecurityProfile[]>("market_profiles_list"),
    indices: () => invoke<IndexQuote[]>("market_indices"),
    refresh: () => invoke<MarketRefreshReport>("market_refresh"),
    indexHistory: () => invoke<[string, number][]>("market_index_history"),
    indexDepth: () => invoke<number>("market_index_depth"),
    indexBackfill: () => invoke<number>("market_index_backfill"),
  },
  simplefin: {
    status: () => invoke<SimplefinStatus>("simplefin_status"),
    connect: (setupToken: string) => invoke<SyncReport>("simplefin_connect", { setupToken }),
    sync: () => invoke<SyncReport>("simplefin_sync"),
    backfill: (days: number) => invoke<SyncReport>("simplefin_backfill", { days }),
    diagnose: () => invoke<SimplefinSample>("simplefin_diagnose"),
    disconnect: (deleteAccounts: boolean) => invoke<void>("simplefin_disconnect", { deleteAccounts }),
  },
  copilot: {
    /** A dry run: what importing this Copilot export would do. */
    preview: (path: string) => invoke<CopilotPlan>("copilot_preview", { path }),
    /** Backs up, then imports in one transaction. */
    import: (path: string, removeIds: number[]) => invoke<CopilotCounts>("copilot_import", { path, removeIds }),
  },
  backup: {
    status: () => invoke<BackupStatus>("backup_status"),
    list: () => invoke<BackupEntry[]>("backup_list"),
    now: () => invoke<BackupAttempt>("backup_now"),
    setExtraFolder: (folder: string | null) => invoke<void>("backup_set_extra_folder", { folder }),
    /** Restarts the app on success, so the promise only ever settles with an error. */
    restore: (path: string) => invoke<void>("backup_restore", { path }),
    exportCsv: (folder: string) => invoke<string>("export_csv", { folder }),
    reveal: (path: string) => invoke<void>("reveal_path", { path }),
  },
  categories: {
    list: () => invoke<Category[]>("categories_list"),
    create: (name: string, kind: string, colour: string) =>
      invoke<Category>("categories_create", { name, kind, colour }),
    update: (id: number, name: string, colour: string) =>
      invoke<void>("categories_update", { id, name, colour }),
    delete: (id: number) => invoke<void>("categories_delete", { id }),
  },
  bankTransactions: {
    list: (from: string, to: string) =>
      invoke<BankTransaction[]>("bank_transactions_list", { from, to }),
    range: () => invoke<[string | null, string | null]>("bank_transactions_range"),
    setCategory: (id: number, categoryId: number | null, applyToPayee: boolean) =>
      invoke<number>("bank_transaction_set_category", { id, categoryId, applyToPayee }),
    toReview: () => invoke<BankTransaction[]>("bank_transactions_to_review"),
    approve: (ids: number[]) => invoke<number>("bank_transactions_approve", { ids }),
    /** Remove from Spending (paid back), or restore. Never deletes. */
    setRemoved: (ids: number[], removed: boolean) => invoke<number>("bank_transactions_set_removed", { ids, removed }),
  },
  rules: {
    list: () => invoke<CategoryRule[]>("rules_list"),
    delete: (id: number) => invoke<void>("rules_delete", { id }),
  },
  budgets: {
    list: () => invoke<Budget[]>("budgets_list"),
    set: (categoryId: number, month: string | null, amount: number) =>
      invoke<void>("budget_set", { categoryId, month, amount }),
  },
  accountTypes: {
    set: (id: number, kind: string) => invoke<void>("accounts_set_type", { id, kind }),
  },
};
