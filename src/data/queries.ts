import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type NewAccount, type NewTransaction } from "./api";
import { writeLastSync, clearLastSync } from "./lastSync";
import { MIN_HISTORY_DAYS } from "../domain/risk";

export const keys = {
  accounts: ["accounts"] as const,
  securities: ["securities"] as const,
  transactions: ["transactions"] as const,
  latest: ["prices", "latest"] as const,
  previous: ["prices", "previous"] as const,
  snapshots: ["snapshots"] as const,
  historyDepth: ["prices", "historyDepth"] as const,
  priceHistory: (from: string) => ["prices", "history", from] as const,
  synced: ["synced_holdings"] as const,
  simplefin: ["simplefin", "status"] as const,
  marketNews: ["market", "news"] as const,
  marketEarnings: ["market", "earnings"] as const,
  marketProfiles: ["market", "profiles"] as const,
  marketIndices: ["market", "indices"] as const,
  indexHistory: ["market", "indexHistory"] as const,
  indexDepth: ["market", "indexDepth"] as const,
  backupStatus: ["backup", "status"] as const,
  backupList: ["backup", "list"] as const,
};

export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: api.accounts.list });
export const useSecurities = () => useQuery({ queryKey: keys.securities, queryFn: api.securities.list });
export const useTransactions = () => useQuery({ queryKey: keys.transactions, queryFn: api.transactions.list });
export const useLatestPrices = () => useQuery({ queryKey: keys.latest, queryFn: api.prices.latest });
export const usePreviousPrices = () => useQuery({ queryKey: keys.previous, queryFn: api.prices.previous });
export const useSnapshots = () => useQuery({ queryKey: keys.snapshots, queryFn: api.snapshots.list });
export const useSyncedHoldings = () => useQuery({ queryKey: keys.synced, queryFn: api.syncedHoldings.list });
export const useSimplefinStatus = () => useQuery({ queryKey: keys.simplefin, queryFn: api.simplefin.status });

/** Everything a sync can change. A sync can now also remove an account the
 *  user stopped sharing, which cascades away its transactions, so the
 *  transaction lists are refreshed too. */
function invalidateAfterSync(qc: ReturnType<typeof useQueryClient>) {
  // historyDepth too: a newly synced holding has no price history, and the
  // depth dropping is what tells usePriceHistory to fetch it.
  for (const k of [keys.accounts, keys.securities, keys.synced, keys.latest, keys.previous, keys.simplefin, keys.transactions, keys.historyDepth]) {
    qc.invalidateQueries({ queryKey: k });
  }
  qc.invalidateQueries({ queryKey: ["bankTxns"] });
}
export function useSimplefinConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.simplefin.connect(token),
    onSuccess: writeLastSync,
    onSettled: () => invalidateAfterSync(qc),
  });
}
export function useSimplefinSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.simplefin.sync(),
    onSuccess: writeLastSync,
    onSettled: () => invalidateAfterSync(qc),
  });
}
export function useSimplefinDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deleteAccounts: boolean) => api.simplefin.disconnect(deleteAccounts),
    onSuccess: clearLastSync,
    onSettled: () => { invalidateAfterSync(qc); qc.invalidateQueries({ queryKey: keys.transactions }); },
  });
}

export const usePriceHistoryDepth = () =>
  useQuery({ queryKey: keys.historyDepth, queryFn: api.prices.historyDepth });

export const usePriceHistoryRows = (from: string) =>
  useQuery({ queryKey: keys.priceHistory(from), queryFn: () => api.prices.history(from) });

export function useBackfillPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.prices.backfill(MIN_HISTORY_DAYS),
    // Every "prices" query, the chart's history rows included: invalidating only
    // depth and the latest closes left the chart showing its empty state until
    // something else happened to refetch it.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["prices"] }); },
  });
}
export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: NewAccount) => api.accounts.create(a),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}
export function useSetAccountHidden() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hidden }: { id: number; hidden: boolean }) => api.accounts.setHidden(id, hidden),
    // Hiding changes every derived figure, so everything derivePortfolio reads
    // has to refetch, not just the account list.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.accounts });
      qc.invalidateQueries({ queryKey: keys.transactions });
      qc.invalidateQueries({ queryKey: keys.synced });
    },
  });
}
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.accounts.delete(id),
    // Deleting an account cascades to its transactions in the DB, so the
    // transaction-derived views (Holdings/Dashboard/Activity) must refetch too.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.accounts });
      qc.invalidateQueries({ queryKey: keys.transactions });
      qc.invalidateQueries({ queryKey: keys.synced });
    },
  });
}
export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: NewTransaction) => api.transactions.create(t),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transactions }),
  });
}
export function useCreateTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (txns: NewTransaction[]) => api.transactions.createMany(txns),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transactions }),
  });
}
export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.transactions.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transactions }),
  });
}

// ---------- budgeting ----------

export const budgetKeys = {
  categories: ["categories"] as const,
  rules: ["rules"] as const,
  budgets: ["budgets"] as const,
  txns: (from: string, to: string) => ["bankTxns", from, to] as const,
  range: ["bankTxns", "range"] as const,
  toReview: ["bankTxns", "toReview"] as const,
};

export const useCategories = () => useQuery({ queryKey: budgetKeys.categories, queryFn: api.categories.list });
export const useRules = () => useQuery({ queryKey: budgetKeys.rules, queryFn: api.rules.list });
export const useBudgets = () => useQuery({ queryKey: budgetKeys.budgets, queryFn: api.budgets.list });
export const useBankTransactions = (from: string, to: string) =>
  useQuery({ queryKey: budgetKeys.txns(from, to), queryFn: () => api.bankTransactions.list(from, to) });
export const useBankTransactionRange = () =>
  useQuery({ queryKey: budgetKeys.range, queryFn: api.bankTransactions.range });

/** A category change can move rows and rewrite rules, so refetch both. */
function invalidateSpending(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["bankTxns"] });
  qc.invalidateQueries({ queryKey: budgetKeys.categories });
  qc.invalidateQueries({ queryKey: budgetKeys.rules });
}

export const useBankTransactionsToReview = () =>
  useQuery({ queryKey: budgetKeys.toReview, queryFn: api.bankTransactions.toReview });

/** Approving changes which rows are reviewed and makes them manual, so the
 *  month lists and the review list are refetched together. */
export function useApproveTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.bankTransactions.approve(ids),
    onSuccess: () => invalidateSpending(qc),
  });
}

export function useSetTransactionCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; categoryId: number | null; applyToPayee: boolean }) =>
      api.bankTransactions.setCategory(v.id, v.categoryId, v.applyToPayee),
    onSuccess: () => invalidateSpending(qc),
  });
}
export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; kind: string; colour: string }) =>
      api.categories.create(v.name, v.kind, v.colour),
    onSuccess: () => invalidateSpending(qc),
  });
}
export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; name: string; colour: string }) =>
      api.categories.update(v.id, v.name, v.colour),
    onSuccess: () => invalidateSpending(qc),
  });
}
export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.categories.delete(id),
    onSuccess: () => { invalidateSpending(qc); qc.invalidateQueries({ queryKey: budgetKeys.budgets }); },
  });
}
export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.rules.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: budgetKeys.rules }),
  });
}
export function useSetBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { categoryId: number; month: string | null; amount: number }) =>
      api.budgets.set(v.categoryId, v.month, v.amount),
    onSuccess: () => qc.invalidateQueries({ queryKey: budgetKeys.budgets }),
  });
}
export function useSetAccountType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; kind: string }) => api.accountTypes.set(v.id, v.kind),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}
export function useSimplefinBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.simplefin.backfill(days),
    onSuccess: writeLastSync,
    onSettled: () => { invalidateAfterSync(qc); qc.invalidateQueries({ queryKey: ["bankTxns"] }); },
  });
}

export const useMarketNews = () => useQuery({ queryKey: keys.marketNews, queryFn: api.market.news });
export const useMarketEarnings = () => useQuery({ queryKey: keys.marketEarnings, queryFn: api.market.earnings });
export const useMarketProfiles = () => useQuery({ queryKey: keys.marketProfiles, queryFn: api.market.profiles });
export const useMarketIndices = () => useQuery({ queryKey: keys.marketIndices, queryFn: api.market.indices });

export const useIndexHistory = () =>
  useQuery({ queryKey: keys.indexHistory, queryFn: api.market.indexHistory });

export const useIndexDepth = () =>
  useQuery({ queryKey: keys.indexDepth, queryFn: api.market.indexDepth });

/** The benchmark's two-year backfill. Run once, not on the refresh timer. */
export function useBackfillIndices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.market.indexBackfill(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.indexDepth });
      qc.invalidateQueries({ queryKey: keys.indexHistory });
      qc.invalidateQueries({ queryKey: keys.marketIndices });
    },
  });
}

/** Read-only: it changes nothing, so there is nothing to invalidate. A
 *  mutation rather than a query because it must only run when clicked. */
export function useSimplefinDiagnose() {
  return useMutation({ mutationFn: () => api.simplefin.diagnose() });
}

/** A market refresh can change all four, so they are invalidated together. */
export function useMarketRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.market.refresh(),
    onSettled: () => {
      for (const k of [keys.marketNews, keys.marketEarnings, keys.marketProfiles, keys.marketIndices]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}

export const useBackupStatus = () => useQuery({ queryKey: keys.backupStatus, queryFn: api.backup.status });
export const useBackupList = () => useQuery({ queryKey: keys.backupList, queryFn: api.backup.list });

/** Status and list both describe the backups folder, so they refresh together. */
function useInvalidateBackups() {
  const qc = useQueryClient();
  return () => { qc.invalidateQueries({ queryKey: ["backup"] }); };
}

export function useBackupNow() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: () => api.backup.now(), onSettled: invalidate });
}

export function useSetExtraFolder() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: (folder: string | null) => api.backup.setExtraFolder(folder), onSuccess: invalidate });
}

export function useRestoreBackup() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: (path: string) => api.backup.restore(path), onSettled: invalidate });
}

/** Read-only, so nothing to invalidate. */
export function useExportCsv() {
  return useMutation({ mutationFn: (folder: string) => api.backup.exportCsv(folder) });
}

/** A dry run: changes nothing, so nothing to invalidate. */
export function useCopilotPreview() {
  return useMutation({ mutationFn: (path: string) => api.copilot.preview(path) });
}

/** An import touches transactions, categories, rules, accounts and backups. */
export function useCopilotImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; removeIds: number[] }) => api.copilot.import(v.path, v.removeIds),
    onSuccess: () => {
      invalidateSpending(qc);
      qc.invalidateQueries({ queryKey: budgetKeys.budgets });
      qc.invalidateQueries({ queryKey: keys.accounts });
      qc.invalidateQueries({ queryKey: ["backup"] });
    },
  });
}

/** Remove (paid back) or restore: changes what the month and review lists hold. */
export function useSetRemoved() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: number[]; removed: boolean }) => api.bankTransactions.setRemoved(v.ids, v.removed),
    onSuccess: () => invalidateSpending(qc),
  });
}
