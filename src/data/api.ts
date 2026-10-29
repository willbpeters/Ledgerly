import { invoke } from "@tauri-apps/api/core";
import type {
  Account, Security, Transaction, Snapshot,
  SyncedHolding, SyncReport, SimplefinStatus, SimplefinSample,
  Category, CategoryKind, BankTransaction, CategoryRule, Budget, NewSplit, NewBankTxn,
  NewAccount, NewTransaction,
  NewsItem, EarningsEvent, SecurityProfile, IndexQuote, MarketRefreshReport,
  BackupEntry, BackupAttempt, BackupStatus, CopilotPlan, CopilotCounts,
  DeviceSyncReport, DeviceSyncStatus,
  Goal, NewGoal,
} from "../domain/types";

export type { NewAccount, NewTransaction };
import type { RowState } from "./undo";

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
    /** Backs up, then imports in one transaction: Tally becomes Copilot's
     *  copy up to the export's last day, in exactly Copilot's categories. */
    import: (path: string) => invoke<CopilotCounts>("copilot_import", { path }),
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
  deviceSync: {
    status: () => invoke<DeviceSyncStatus>("device_sync_status"),
    startFirst: (folder: string) => invoke<void>("device_sync_start_first", { folder }),
    /** Restarts the app on success, so the promise only ever settles with an error. */
    join: (folder: string) => invoke<void>("device_sync_join", { folder }),
    /** `null` when sync is off. */
    now: () => invoke<DeviceSyncReport | null>("device_sync_now"),
    /** A warning when sync is off but the last edits couldn't be sent, else `null`. */
    stop: () => invoke<string | null>("device_sync_stop"),
  },
  categories: {
    list: () => invoke<Category[]>("categories_list"),
    create: (name: string, kind: string, colour: string) =>
      invoke<Category>("categories_create", { name, kind, colour }),
    update: (id: number, name: string, colour: string) =>
      invoke<void>("categories_update", { id, name, colour }),
    delete: (id: number) => invoke<void>("categories_delete", { id }),
    /** What it counts as: spending, income, or neither ("transfer"). */
    setKind: (id: number, kind: CategoryKind) => invoke<void>("categories_set_kind", { id, kind }),
    /** Backs up, then removes every category; returns how many went. */
    clear: () => invoke<number>("categories_clear"),
  },
  bankTransactions: {
    list: (from: string, to: string) =>
      invoke<BankTransaction[]>("bank_transactions_list", { from, to }),
    range: () => invoke<[string | null, string | null]>("bank_transactions_range"),
    setCategory: (id: number, categoryId: number | null, applyToPayee: boolean) =>
      invoke<number>("bank_transaction_set_category", { id, categoryId, applyToPayee }),
    /** Split across categories; no pieces unsplits. Refused unless they add up. */
    setSplits: (id: number, splits: NewSplit[]) =>
      invoke<void>("bank_transaction_set_splits", { id, splits }),
    /** The owner's note; a blank one clears it. */
    setNote: (id: number, note: string) => invoke<void>("bank_transaction_set_note", { id, note }),
    /** Add one by hand (cash, say) to any spending account. Returns its id. */
    add: (txn: NewBankTxn) => invoke<number>("bank_transaction_add", { txn }),
    /** Only for one added by hand; a bank's is removed instead. */
    delete: (id: number) => invoke<void>("bank_transaction_delete", { id }),
    toReview: () => invoke<BankTransaction[]>("bank_transactions_to_review"),
    approve: (ids: number[]) => invoke<number>("bank_transactions_approve", { ids }),
    /** Remove from Spending (paid back), or restore. Never deletes. */
    setRemoved: (ids: number[], removed: boolean) => invoke<number>("bank_transactions_set_removed", { ids, removed }),
    /** Undo: put rows back as they were before an action. */
    restore: (states: RowState[]) => invoke<number>("bank_transactions_restore", { states }),
  },
  rules: {
    list: () => invoke<CategoryRule[]>("rules_list"),
    /** A rule of the owner's own; sorts history at once. Returns rows moved. */
    create: (matchType: "payee" | "description", pattern: string, categoryId: number) =>
      invoke<number>("rules_create", { matchType, pattern, categoryId }),
    delete: (id: number) => invoke<void>("rules_delete", { id }),
  },
  budgets: {
    list: () => invoke<Budget[]>("budgets_list"),
    set: (categoryId: number, month: string | null, amount: number) =>
      invoke<void>("budget_set", { categoryId, month, amount }),
  },
  recurring: {
    /** Payee keys the owner said are not bills; see `recurringKey`. */
    dismissed: () => invoke<string[]>("recurring_dismissed_list"),
    dismiss: (key: string) => invoke<void>("recurring_dismiss", { key }),
    undismiss: (key: string) => invoke<void>("recurring_undismiss", { key }),
  },
  accountTypes: {
    set: (id: number, kind: string) => invoke<void>("accounts_set_type", { id, kind }),
  },
  goals: {
    list: () => invoke<Goal[]>("goals_list"),
    create: (goal: NewGoal) => invoke<Goal>("goals_create", { goal }),
    update: (id: number, goal: NewGoal) => invoke<void>("goals_update", { id, goal }),
    delete: (id: number) => invoke<void>("goals_delete", { id }),
  },
};
