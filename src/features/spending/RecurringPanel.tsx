import { useMemo, useState } from "react";
import {
  cadenceLabel, detectRecurring, monthOutlook, namesForKeys, statusOf, type RecurringSeries,
} from "../../domain/recurring";
import { localIsoDate } from "../../domain/dates";
import { money } from "../../ui/format";
import { Badge, Card, EmptyState } from "../../ui/components";
import { useToast } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

/** `Oct 25`: a due date is always close, so the year adds nothing. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** For a bill still being charged only: one not seen lately has no status. */
function StatusBadge({ series, today }: { series: RecurringSeries; today: string }) {
  const status = statusOf(series, today);
  if (status.kind === "paid") return <Badge tone="pos">Paid this month</Badge>;
  if (status.kind === "late") return <Badge tone="warn">Late · expected {shortDate(status.since)}</Badge>;
  return <Badge tone="neutral">Due {shortDate(status.date)}</Badge>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Bills and subscriptions Tally has spotted in the history, with what is
 * still due this month. `transactions` is everything that counts toward
 * spending, from every month; detection decides which of it repeats.
 */
export function RecurringPanel({ transactions, loading, categories, accounts, dismissed, onSetDismissed, today = localIsoDate() }: {
  transactions: BankTransaction[];
  loading: boolean;
  categories: Category[];
  accounts: Account[];
  /** Keys the owner said are not bills. */
  dismissed: string[];
  /** Resolves once the change is saved, so Undo is never offered before it. */
  onSetDismissed: (key: string, dismissed: boolean) => Promise<unknown>;
  /** For tests; the screen always means the owner's today. */
  today?: string;
}) {
  const toast = useToast();
  const [showStale, setShowStale] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  // One `today` for detection, status and the month's figures, so they agree.
  const series = useMemo(
    () => detectRecurring(transactions, categories, today, dismissed),
    [transactions, categories, today, dismissed],
  );
  const live = series.filter((s) => s.active);
  const stale = series.filter((s) => !s.active);
  const outlook = useMemo(() => monthOutlook(series, today), [series, today]);
  // A weekly bill can come due several times: count the bills, not the charges.
  const dueBills = new Set(outlook.due.map((d) => d.key)).size;
  const dismissedRows = useMemo(() => namesForKeys(transactions, dismissed), [transactions, dismissed]);
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "—";

  async function dismiss(s: RecurringSeries) {
    try {
      await onSetDismissed(s.key, true);
    } catch (e) {
      toast.push({ tone: "neg", title: "Couldn't change that", body: String(e) });
      return;
    }
    // Only after the dismiss has gone through: Undo can never race ahead of it.
    toast.push({
      tone: "neutral",
      title: `${s.name} is off the list`,
      action: {
        label: "Undo",
        onClick: () => {
          onSetDismissed(s.key, false).catch((e) => toast.push({ tone: "neg", title: "Couldn't undo", body: String(e) }));
        },
      },
    });
  }

  function table(rows: RecurringSeries[], current: boolean) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Bill</th>
              <th className="left">How often</th>
              <th>Amount</th>
              <th className="left">{current ? "Next" : "Last"}</th>
              <th className="left">Status</th>
              <th className="left">Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.key}>
                <td className="left">
                  <div className="cell-primary">{s.name}</div>
                  <div className="cell-secondary">{s.count} charges</div>
                </td>
                <td className="left">{cadenceLabel(s.cadence)}</td>
                <td style={{ fontWeight: 600 }}>{money(s.amount)}</td>
                <td className="left">{shortDate(current ? s.nextDate : s.lastDate)}</td>
                <td className="left">
                  {current ? <StatusBadge series={s} today={today} />
                    : <span className="muted">Last seen {shortDate(s.lastDate)}</span>}
                </td>
                <td className="left cell-secondary">{accountName(s.accountId)}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" aria-label={`Not recurring: ${s.name}`}
                    title="This isn't a bill" onClick={() => dismiss(s)}>Not recurring</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-2">
        <div className="card stat">
          <div className="stat-label">Still due this month</div>
          <div className="stat-value n">{money(outlook.dueTotal)}</div>
          <div className="stat-hint">{plural(dueBills, "bill", "bills")} to come</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Paid this month</div>
          <div className="stat-value n">{money(outlook.paidTotal)}</div>
          <div className="stat-hint">charged by {plural(outlook.paidCount, "bill", "bills")}</div>
        </div>
      </div>

      <Card
        title="Recurring"
        subtitle="Bills and subscriptions Tally spotted: the same payee, at a steady amount, on a regular schedule. Soonest first."
      >
        {loading ? <p className="muted">Loading…</p> : live.length === 0 && stale.length === 0 ? (
          <EmptyState
            title="No bills spotted yet"
            body="Tally lists a bill once it has seen three charges from the same payee, at a steady amount and a regular interval: weekly, monthly, yearly and so on."
          />
        ) : (
          <>
            {live.length > 0 ? table(live, true) : <p className="muted">Nothing is being charged right now.</p>}
            {stale.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowStale(!showStale)}>
                  {showStale ? "Hide not seen lately" : `Not seen lately (${stale.length})`}
                </button>
                {showStale && (
                  <>
                    <div className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
                      Overdue for a while: probably cancelled. Left out of this month's figures.
                    </div>
                    {table(stale, false)}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {dismissedRows.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDismissed(!showDismissed)}>
              {showDismissed ? "Hide dismissed" : `Dismissed (${dismissedRows.length})`}
            </button>
            {showDismissed && (
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>You said these aren't bills. Restore puts one back.</div>
                {dismissedRows.map((d) => (
                  <div key={d.key} className="row center between" style={{ gap: 8 }}>
                    <span>{d.name}</span>
                    <button className="btn btn-ghost btn-sm" aria-label={`Restore ${d.name}`}
                      onClick={() => onSetDismissed(d.key, false).catch((e) =>
                        toast.push({ tone: "neg", title: "Couldn't restore", body: String(e) }))}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
