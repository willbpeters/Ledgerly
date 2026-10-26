import { useMemo, useState } from "react";
import { useGoals, useDeleteGoal } from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { localIsoDate } from "../../domain/dates";
import { goalProgress, savedFor, type GoalProgress, type SavedSource } from "../../domain/goals";
import { money, share } from "../../ui/format";
import { Button, Card, EmptyState, PageHeader } from "../../ui/components";
import { askToConfirm } from "../../ui/confirm";
import { useToast } from "../../ui/toast";
import type { Account, Goal } from "../../domain/types";
import { GoalForm } from "./GoalForm";

/** "March 1, 2027" for `2027-03-01`, read as that calendar day wherever the owner is. */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The sentence under a goal's bar: what it takes from here. */
export function goalLine(p: GoalProgress, targetDate: string | null): string {
  if (p.done) return "Reached";
  if (p.overdue) return `The date has passed — ${money(p.remaining)} to go`;
  if (p.perMonth == null || targetDate == null) return `${money(p.remaining)} to go`;
  if (p.monthsLeft === 0) return `Due today — ${money(p.remaining)} to go`;
  return `${money(p.perMonth)} a month to reach it by ${dayLabel(targetDate)}`;
}

/** Where the saved figure comes from, so a number that never moves is explained. */
function sourceLine(source: SavedSource, account: Account | undefined): string {
  if (source === "account") return `Following ${account?.name ?? "its account"}`;
  if (source === "missing-account") return "Its account is hidden, so this shows an amount kept by hand. Use Edit to change it.";
  return "Updated by hand";
}

/**
 * What the owner is saving towards. Each goal follows an account's value or an
 * amount kept by hand; the maths is in `src/domain/goals.ts`.
 */
export function Goals() {
  const { data: goals = [], isLoading } = useGoals();
  const { accountValues, accounts, isLoading: loadingAccounts } = usePortfolio();
  const remove = useDeleteGoal();
  const toast = useToast();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const today = localIsoDate();
  // Money set aside lives in cash and investment accounts; a card balance is a
  // debt. `accounts` from usePortfolio already leaves hidden ones out.
  const trackable = accounts.filter((a) => a.type !== "credit");
  // Visible accounts, so a followed account with no value yet reads as $0
  // saved and only a hidden one falls back to the amount kept by hand.
  const visibleIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);

  async function del(g: Goal) {
    if (await askToConfirm(`Delete the goal "${g.name}"? Your accounts and transactions are not touched.`)) {
      remove.mutate(g.id, {
        onError: (e) => toast.push({ tone: "neg", title: "Couldn't delete the goal", body: String(e) }),
      });
    }
  }

  // Nothing is drawn until the accounts have loaded, so a visible account is
  // never briefly taken for a hidden one.
  if (isLoading || loadingAccounts) return <p className="muted">Loading…</p>;

  return (
    <>
      <PageHeader
        subtitle="What you're saving towards"
        actions={goals.length > 0 && editing !== "new" && (
          <Button size="sm" onClick={() => setEditing("new")}>Add a goal</Button>
        )}
      />

      {editing === "new" && (
        <Card title="New goal">
          <GoalForm accounts={trackable} onDone={() => setEditing(null)} />
        </Card>
      )}

      {goals.length === 0 && editing !== "new" && (
        <Card>
          <EmptyState
            title="No goals yet"
            body="Set a target, like an emergency fund, a trip or a house deposit, and Tally shows how close you are and what to put aside each month."
            action={<Button onClick={() => setEditing("new")}>Add a goal</Button>}
          />
        </Card>
      )}

      {goals.map((g) => {
        const { saved, source } = savedFor(g, accountValues, visibleIds);
        const p = goalProgress(g, saved, today);
        return (
          <Card
            key={g.id}
            title={g.name}
            actions={editing !== g.id && (
              <div className="row center" style={{ gap: 6 }}>
                <Button variant="ghost" size="sm" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g.id)}>Edit</Button>
                <Button variant="ghost" size="sm" aria-label={`Delete ${g.name}`} onClick={() => del(g)}>Delete</Button>
              </div>
            )}
          >
            {editing === g.id ? (
              <GoalForm goal={g} accounts={trackable} onDone={() => setEditing(null)} />
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="row center between">
                  <div>
                    <span className="n" style={{ fontWeight: 600, fontSize: 18 }}>{money(p.saved)}</span>{" "}
                    <span className="muted">of {money(p.target)}</span>
                  </div>
                  <span className="n muted">{share(p.fraction)}</span>
                </div>
                <span className="bar-track" aria-hidden="true" style={{ width: "auto", height: 8 }}>
                  <span className="bar-fill" style={{
                    width: `${p.fraction * 100}%`,
                    background: p.done ? "var(--pos)" : undefined,
                  }} />
                </span>
                <div className={p.overdue ? "neg" : p.done ? "pos" : undefined}>{goalLine(p, g.target_date)}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {sourceLine(source, accounts.find((a) => a.id === g.account_id))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
