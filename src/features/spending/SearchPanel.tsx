import { useMemo, useState } from "react";
import { searchTransactions, type TxnSearch } from "../../domain/search";
import { amountInCategory } from "../../domain/splits";
import { money } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { TransactionList } from "./TransactionList";
import type { Account, BankTransaction, Category } from "../../domain/types";

/** Rendering thousands of rows, each with a category picker, makes typing lag. */
const SHOW_AT_MOST = 200;

/**
 * Search every month at once: words find payees, descriptions, notes,
 * categories and accounts; a number finds that amount; >100 or <20 compare
 * sizes. `transactions` is everything that counts toward spending.
 */
export function SearchPanel({ initialText = "", transactions, loading, categories, accounts, colourOf, onRemove }: {
  /** What was typed in the command bar's search box, if that is how we got here. */
  initialText?: string;
  transactions: BankTransaction[];
  loading: boolean;
  categories: Category[];
  accounts: Account[];
  colourOf: (token: string) => string;
  onRemove: (id: number) => void;
}) {
  const [search, setSearch] = useState<TxnSearch>({ text: initialText, categoryId: null, accountId: null });
  const searching = search.text.trim() !== "" || search.categoryId != null || search.accountId != null;

  const matches = useMemo(
    () => (searching ? searchTransactions(transactions, search, { categories, accounts }) : []),
    [searching, transactions, search, categories, accounts],
  );
  // With a category filter, a split purchase counts only the pieces in that
  // category; otherwise the whole amount, as the bank has it.
  const counted = (t: BankTransaction) =>
    search.categoryId == null ? t.amount : amountInCategory(t, search.categoryId);
  const out = matches.reduce((s, t) => s + Math.min(counted(t), 0), 0);
  const into = matches.reduce((s, t) => s + Math.max(counted(t), 0), 0);

  return (
    <Card
      title="Search"
      subtitle="Every month at once. Type a payee, a note or a category; a number finds that amount, and >100 or <20 compare sizes."
    >
      <div className="row center" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input
          autoFocus
          type="search"
          value={search.text}
          onChange={(e) => setSearch({ ...search, text: e.target.value })}
          placeholder="Whole Foods, 42.10, >100…"
          aria-label="Search transactions"
          style={{ flex: "1 1 240px", minWidth: 0 }}
        />
        <select
          value={search.categoryId ?? ""}
          onChange={(e) => setSearch({
            ...search,
            categoryId: e.target.value === "" ? null : e.target.value === "uncategorised" ? "uncategorised" : Number(e.target.value),
          })}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          <option value="uncategorised">Uncategorised</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={search.accountId ?? ""}
          onChange={(e) => setSearch({ ...search, accountId: e.target.value === "" ? null : Number(e.target.value) })}
          aria-label="Filter by account"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {!searching ? (
        <EmptyState title="Search all your transactions" body="Results from every month appear here as you type." />
      ) : loading ? (
        <p className="muted">Loading…</p>
      ) : matches.length === 0 ? (
        <EmptyState title="No matches" body="Try fewer words, or clear a filter." />
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {matches.length} transaction{matches.length === 1 ? "" : "s"}
            {out < 0 && <> · {money(-out)} out</>}
            {into > 0 && <> · {money(into)} in</>}
            {matches.length > SHOW_AT_MOST && <> · showing the newest {SHOW_AT_MOST}; narrow the search to see the rest</>}
          </div>
          <TransactionList
            transactions={matches.slice(0, SHOW_AT_MOST)}
            categories={categories}
            accounts={accounts}
            colourOf={colourOf}
            onRemove={onRemove}
          />
        </>
      )}
    </Card>
  );
}
