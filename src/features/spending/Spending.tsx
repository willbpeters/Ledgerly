import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useBankTransactions, useCategories, useBudgets, useAccounts, useBankTransactionRange,
  useBankTransactionsToReview, useApproveTransactions, useSetRemoved,
} from "../../data/queries";
import { monthWindow, monthLabel, shiftMonth, thisMonth, summariseMonth, fromVisibleAccounts } from "../../domain/spending";
import { money } from "../../ui/format";
import { Card, Button, EmptyState, Segmented } from "../../ui/components";
import { useChartColors } from "../../ui/chartColors";
import { TransactionList } from "./TransactionList";
import { BudgetRow } from "./BudgetRow";
import { Icons } from "../../app/icons";
import { askToRemove } from "../../ui/confirm";
import { useOfferUndo, askBeforeRemove, setAskBeforeRemove } from "../../data/undo";

type View = "month" | "review";

export function Spending() {
  const [view, setView] = useState<View>("month");
  const [month, setMonth] = useState(thisMonth);
  const [focus, setFocus] = useState<number | "uncategorised" | null>(null);
  const { from, to } = monthWindow(month);

  const { data: allTxns = [], isLoading } = useBankTransactions(from, to);
  const { data: categories = [] } = useCategories();
  const { data: budgets = [] } = useBudgets();
  const { data: allAccounts = [] } = useAccounts();
  // A hidden account is out of every total, and spending is a total.
  const accounts = allAccounts.filter((a) => !a.hidden);
  const txns = fromVisibleAccounts(allTxns, allAccounts);
  const { data: range } = useBankTransactionRange();
  const colours = useChartColors();

  // The review list obeys the same filter as the month: a hidden account or an
  // investment account has nothing to review here.
  const { data: allToReview = [] } = useBankTransactionsToReview();
  const toReview = fromVisibleAccounts(allToReview, allAccounts);
  const approve = useApproveTransactions();

  // Removing is for being paid back: out of Spending, restorable, never deleted.
  const setRemoved = useSetRemoved();
  const [showRemoved, setShowRemoved] = useState(false);
  const hiddenAccounts = new Set(allAccounts.filter((a) => a.hidden || a.type === "brokerage").map((a) => a.id));
  const removedThisMonth = allTxns.filter((t) => t.removed && !hiddenAccounts.has(t.account_id));
  const offerUndo = useOfferUndo();
  const byId = (id: number) => [...allTxns, ...allToReview].filter((t) => t.id === id).slice(0, 1);

  async function removeOne(id: number) {
    if (askBeforeRemove()) {
      const answer = await askToRemove();
      if (answer === "cancel") return;
      if (answer === "remove-always") setAskBeforeRemove(false);
    }
    const before = byId(id);
    setRemoved.mutate({ ids: [id], removed: true }, { onSuccess: () => offerUndo("Removed from spending", before) });
  }

  function restoreOne(id: number) {
    const before = byId(id);
    setRemoved.mutate({ ids: [id], removed: false }, { onSuccess: () => offerUndo("Restored", before) });
  }

  function approveSome(ids: number[]) {
    const before = toReview.filter((t) => ids.includes(t.id));
    approve.mutate(ids, {
      onSuccess: () => offerUndo(ids.length === 1 ? "Marked reviewed" : `Marked ${ids.length} reviewed`, before),
    });
  }

  const summary = useMemo(
    () => summariseMonth(txns, categories, budgets, month),
    [txns, categories, budgets, month],
  );

  const colourOf = (token: string) => {
    const i = Number(token.replace("chart-", "")) - 1;
    return colours.series[Number.isFinite(i) && i >= 0 ? i % colours.series.length : 0];
  };

  const shown = txns.filter((t) =>
    focus == null ? true : focus === "uncategorised" ? t.category_id == null : t.category_id === focus);

  const nothingImported = (range?.[0] ?? null) == null;

  if (nothingImported && !isLoading) {
    return (
      <Card>
        <EmptyState
          title="No spending imported yet"
          body={<>Connect SimpleFIN in <Link to="/settings">Settings</Link> and Tally will pull
            your bank and credit-card transactions, then sort them into categories for you.</>}
        />
      </Card>
    );
  }

  return (
    <>
      <div className="row center between" style={{ gap: 16 }}>
        <div className="row center" style={{ gap: 12 }}>
          <Segmented<View> value={view} onChange={setView} items={[
            { value: "month", label: "Month" },
            { value: "review", label: `To review (${toReview.length})` },
          ]} />
          {view === "month" && (
            <div className="row center" style={{ gap: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</Button>
              <span className="serif" style={{ fontSize: 20, minWidth: 168, textAlign: "center" }}>{monthLabel(month)}</span>
              <Button variant="ghost" size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</Button>
              {month !== thisMonth() && (
                <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonth())}>Today</Button>
              )}
            </div>
          )}
        </div>
        {view === "month" && focus != null && (
          <Button variant="secondary" size="sm" onClick={() => setFocus(null)}>Showing one category · clear</Button>
        )}
      </div>

      {view === "review" ? (
        <Card
          title="To review"
          subtitle="New transactions, and any Tally couldn't sort. Everything it sorted is already in the Month view. Choosing a category counts as reviewing it."
          actions={toReview.length > 0 ? (
            <Button size="sm" loading={approve.isPending}
              onClick={() => approveSome(toReview.map((t) => t.id))}>
              Mark all reviewed
            </Button>
          ) : undefined}
        >
          {toReview.length === 0 ? (
            <EmptyState title="All caught up" body="New transactions land here after each sync." />
          ) : (
            <TransactionList
              transactions={toReview}
              categories={categories}
              accounts={accounts}
              colourOf={colourOf}
              onApprove={(id) => approveSome([id])}
              onRemove={removeOne}
            />
          )}
        </Card>
      ) : (
        <>
          <div className="grid grid-4">
            <div className="card stat">
              <div className="stat-label">Spent</div>
              <div className="stat-value n">{money(summary.spent)}</div>
              {summary.budgeted > 0 && (
                <div className="stat-hint">of {money(summary.budgeted)} budgeted</div>
              )}
            </div>
            <div className="card stat">
              <div className="stat-label">Income</div>
              <div className="stat-value n pos">{money(summary.income)}</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Left over</div>
              <div className={`stat-value n ${summary.net >= 0 ? "pos" : "neg"}`}>{money(summary.net)}</div>
              <div className="stat-hint">income minus spending</div>
            </div>
            <div className="card stat">
              <div className="stat-label">Needs a category</div>
              <div className="stat-value n">{summary.uncategorisedCount}</div>
              {summary.uncategorisedCount > 0 && (
                <button className="btn btn-ghost btn-sm" style={{ padding: 0, justifyContent: "flex-start" }}
                  onClick={() => setFocus("uncategorised")}>
                  {money(summary.uncategorisedTotal)} · review
                </button>
              )}
            </div>
          </div>

          <Card title="Categories" subtitle="Click a category to filter the list below. Set a limit to track it.">
            {isLoading ? <p className="muted">Loading…</p> : (
              <div style={{ display: "grid", gap: 4 }}>
                {summary.categories.map((row) => (
                  <BudgetRow
                    key={row.category.id}
                    row={row}
                    month={month}
                    colour={colourOf(row.category.colour)}
                    selected={focus === row.category.id}
                    onSelect={() => setFocus(focus === row.category.id ? null : row.category.id)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Transactions"
            actions={
              <div className="row center" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 11 }}>{shown.length} in {monthLabel(month)}</span>
                {removedThisMonth.length > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowRemoved(!showRemoved)}>
                    {showRemoved ? "Hide removed" : `Show removed (${removedThisMonth.length})`}
                  </button>
                )}
              </div>
            }
          >
            {isLoading ? <p className="muted">Loading…</p> : shown.length === 0 ? (
              <EmptyState title="Nothing here"
                body={focus == null ? "No transactions posted in this month." : "No transactions in that category this month."} />
            ) : (
              <TransactionList
                transactions={shown}
                categories={categories}
                accounts={accounts}
                colourOf={colourOf}
                onRemove={removeOne}
              />
            )}
            {showRemoved && removedThisMonth.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Removed: left out of spending and budgets. Restore puts one back.
                </div>
                <TransactionList
                  transactions={removedThisMonth}
                  categories={categories}
                  accounts={accounts}
                  colourOf={colourOf}
                  onRestore={restoreOne}
                />
              </div>
            )}
          </Card>

          {summary.transferred > 0 && (
            <div className="muted" style={{ fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
              <Icons.sync size={13} />
              {money(summary.transferred)} moved between your own accounts, left out of both figures.
            </div>
          )}
        </>
      )}
    </>
  );
}
