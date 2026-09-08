import { useEffect, useState } from "react";
import { useSetBudget } from "../../data/queries";
import { money } from "../../ui/format";
import type { CategorySpend } from "../../domain/spending";

/**
 * One category in the month view: what was spent, its limit, and how far
 * through that limit you are. Clicking the amount lets you set the limit.
 */
export function BudgetRow({ row, month, colour, selected, onSelect }: {
  row: CategorySpend;
  month: string;
  colour: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const setBudget = useSetBudget();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [everyMonth, setEveryMonth] = useState(true);

  useEffect(() => {
    if (editing) setDraft(row.limit == null ? "" : String(row.limit));
  }, [editing, row.limit]);

  function save() {
    const amount = Number(draft);
    if (draft.trim() !== "" && !Number.isFinite(amount)) return;
    setBudget.mutate(
      { categoryId: row.category.id, month: everyMonth ? null : month, amount: draft.trim() === "" ? 0 : amount },
      { onSettled: () => setEditing(false) },
    );
  }

  return (
    <div style={{
      display: "grid", gap: 6, padding: "10px 8px", borderRadius: 10,
      background: selected ? "var(--surface-2)" : undefined,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={onSelect}
          className="btn btn-ghost"
          style={{ padding: 0, gap: 9, flex: 1, justifyContent: "flex-start", fontWeight: 600 }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 3, background: colour, flexShrink: 0 }} />
          {row.category.name}
          {row.count > 0 && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{row.count}</span>}
        </button>

        <span className={`n ${row.over ? "neg" : ""}`} style={{ fontWeight: 600 }}>{money(row.spent)}</span>

        {editing ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
              inputMode="decimal" placeholder="No limit" style={{ width: 92 }} aria-label="Monthly limit"
            />
            <label style={{ flexDirection: "row", alignItems: "center", gap: 5, fontSize: 11 }}>
              <input type="checkbox" checked={everyMonth} onChange={(e) => setEveryMonth(e.target.checked)} />
              every month
            </label>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={setBudget.isPending}>Save</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}
            style={{ minWidth: 118, justifyContent: "flex-end" }}>
            {row.limit == null
              ? <span className="muted">Set a limit</span>
              : <span className="n muted">of {money(row.limit)}</span>}
          </button>
        )}
      </div>

      {row.limit != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="bar-track" style={{ flex: 1, width: "auto", height: 6 }}>
            <span className="bar-fill" style={{
              width: `${row.progress * 100}%`,
              background: row.over ? "var(--neg)" : colour,
            }} />
          </span>
          <span className={`n ${row.over ? "neg" : "muted"}`} style={{ fontSize: 11, width: 128, textAlign: "right" }}>
            {row.over
              ? `${money(Math.abs(row.remaining ?? 0))} over`
              : `${money(row.remaining ?? 0)} left`}
          </span>
        </div>
      )}
    </div>
  );
}
