import { invoke } from "@tauri-apps/api/core";
import type {
  Account, Security, Transaction, Snapshot,
  SyncedHolding, SyncReport, SimplefinStatus,
  Category, BankTransaction, CategoryRule, Budget,
} from "../domain/types";

export interface NewAccount { name: string; type: string; institution: string | null; }
export interface NewTransaction {
  account_id: number; security_id: number | null; type: string; date: string;
  quantity: number; price: number; amount: number; fees: number; note: string | null;
}

export const api = {
  accounts: {
    list: () => invoke<Account[]>("accounts_list"),
    create: (account: NewAccount) => invoke<Account>("accounts_create", { account }),
    delete: (id: number) => invoke<void>("accounts_delete", { id }),
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
  },
  snapshots: {
    list: () => invoke<Snapshot[]>("snapshots_list"),
    record: (date: string, total_value: number) =>
      invoke<void>("snapshots_record", { date, totalValue: total_value }),
  },
  syncedHoldings: {
    list: () => invoke<SyncedHolding[]>("synced_holdings_list"),
  },
  simplefin: {
    status: () => invoke<SimplefinStatus>("simplefin_status"),
    connect: (setupToken: string) => invoke<SyncReport>("simplefin_connect", { setupToken }),
    sync: () => invoke<SyncReport>("simplefin_sync"),
    backfill: (days: number) => invoke<SyncReport>("simplefin_backfill", { days }),
    disconnect: (deleteAccounts: boolean) => invoke<void>("simplefin_disconnect", { deleteAccounts }),
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
