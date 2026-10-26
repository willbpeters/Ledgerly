import { useState } from "react";
import { useSetSplits } from "../../data/queries";
import { useOfferSplitUndo } from "../../data/undo";
import { validateSplits, type Piece, type SplitProblem } from "../../domain/splits";
import { money } from "../../ui/format";
import { Button } from "../../ui/components";
import type { BankTransaction, Category } from "../../domain/types";

interface Draft { category_id: number | null; amount: string }

/** A typed amount in dollars. Blank or nonsense is NaN, which the check
 *  reports as a piece with no amount. */
function dollarsOf(text: string): number {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}

/** A split row opens on its pieces; any other on its category holding all of
 *  it, beside an empty piece to type into. */
function firstDrafts(t: BankTransaction): Draft[] {
  if (t.splits.length > 0) {
    return t.splits.map((s) => ({ category_id: s.category_id, amount: Math.abs(s.amount).toFixed(2) }));
  }
  return [
    { category_id: t.category_id, amount: Math.abs(t.amount).toFixed(2) },
    { category_id: null, amount: "" },
  ];
}

function statusLine(problem: SplitProblem | null, left: number, total: number): string {
  switch (problem) {
    case "too-few": return "Split it into at least two pieces.";
    case "no-amount": return "Every piece needs an amount.";
    case "short": return `${money(Math.abs(left))} left to assign.`;
    case "over": return `${money(Math.abs(left))} more than the transaction.`;
    default: return `Adds up to ${money(Math.abs(total))}.`;
  }
}

/**
 * Divide one transaction across categories. Amounts are typed as plain
 * positive numbers and take the transaction's sign, so a refund splits the
 * same way a purchase does. Save stays disabled until the pieces add up;
 * Rust checks the same rules again.
 */
export function SplitEditor({ txn, categories, onDone }: {
  txn: BankTransaction;
  categories: Category[];
  /** Close the editor: after saving, unsplitting or cancelling. */
  onDone: () => void;
}) {
  const setSplits = useSetSplits();
  const offerUndo = useOfferSplitUndo();
  const [drafts, setDrafts] = useState<Draft[]>(() => firstDrafts(txn));
  const sign = txn.amount < 0 ? -1 : 1;
  const pieces: Piece[] = drafts.map((d) => ({ category_id: d.category_id, amount: sign * dollarsOf(d.amount) }));
  const { left, problem } = validateSplits(txn.amount, pieces);
  // Any edit makes an earlier failed save stale.
  const edit = (change: (prev: Draft[]) => Draft[]) => { setSplits.reset(); setDrafts(change); };
  const update = (i: number, change: Partial<Draft>) =>
    edit((prev) => prev.map((d, j) => (j === i ? { ...d, ...change } : d)));

  function save(next: Piece[], title: string) {
    // txn is the row as it was before: exactly what Undo puts back.
    setSplits.mutate(
      { id: txn.id, splits: next.map((p) => ({ category_id: p.category_id, amount: p.amount, note: null })) },
      { onSuccess: () => { offerUndo(title, txn); onDone(); } },
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, padding: "6px 0 10px" }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Split {money(Math.abs(txn.amount))} from {txn.payee ?? txn.description} across categories.
      </div>
      {drafts.map((d, i) => (
        <div key={i} className="row center" style={{ gap: 8 }}>
          <select
            value={d.category_id ?? ""}
            onChange={(e) => update(i, { category_id: e.target.value === "" ? null : Number(e.target.value) })}
            aria-label={`Category for piece ${i + 1}`}
            style={{ padding: "4px 6px", fontSize: 12, maxWidth: 168 }}
          >
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            value={d.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
            inputMode="decimal" placeholder="0.00"
            aria-label={`Amount for piece ${i + 1}`}
            style={{ width: 96 }}
          />
          {drafts.length > 2 && (
            <Button variant="ghost" size="sm" aria-label={`Remove piece ${i + 1}`}
              onClick={() => edit((prev) => prev.filter((_, j) => j !== i))}>×</Button>
          )}
        </div>
      ))}
      <div className="row center" style={{ gap: 10, flexWrap: "wrap" }}>
        <Button variant="ghost" size="sm"
          onClick={() => edit((prev) => [...prev, { category_id: null, amount: "" }])}>Add piece</Button>
        <span className={problem == null ? "muted" : "neg"} style={{ fontSize: 12 }} aria-live="polite">
          {statusLine(problem, left, txn.amount)}
        </span>
      </div>
      {setSplits.error && <div className="neg" style={{ fontSize: 12 }}>{setSplits.error instanceof Error ? setSplits.error.message : String(setSplits.error)}</div>}
      <div className="row center" style={{ gap: 8 }}>
        <Button size="sm" disabled={problem != null} loading={setSplits.isPending}
          onClick={() => save(pieces, "Split saved")}>Save split</Button>
        {txn.splits.length > 0 && (
          <Button size="sm" variant="secondary" disabled={setSplits.isPending}
            onClick={() => save([], "Split removed")}>Unsplit</Button>
        )}
        <Button size="sm" variant="ghost" disabled={setSplits.isPending} onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
