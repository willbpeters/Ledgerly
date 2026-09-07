import { invoke } from "@tauri-apps/api/core";
import type { Account, Security, Transaction, Snapshot } from "../domain/types";

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
};
