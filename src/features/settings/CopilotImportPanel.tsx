import { Card, Button, Segmented } from "../../ui/components";
import { money, fmtDate } from "../../ui/format";
import type { CopilotCounts, CopilotPlan } from "../../domain/types";

export interface CopilotImportPanelProps {
  /** The dry run for the chosen file, once there is one. */
  plan: CopilotPlan | null;
  result: CopilotCounts | null;
  busy: boolean;
  onChoose: () => void;
  onImport: () => void;
  /** Rows Copilot does not have that will be removed: the ticked ones. */
  removeIds: Set<number>;
  onToggleRemove: (id: number) => void;
  onSetAllRemove: (all: boolean) => void;
  /** What to do with transactions Tally has and Copilot doesn't. */
  mode: NotInCopilotMode;
  onModeChange: (mode: NotInCopilotMode) => void;
  /** Whether Tally's categories become only Copilot's. */
  categoryMode: CategoryMode;
  onCategoryModeChange: (mode: CategoryMode) => void;
  /** When replacing, the categories the owner ticked to keep anyway. */
  keepNames: Set<string>;
  onToggleKeep: (name: string) => void;
}

export type NotInCopilotMode = "remove" | "keep";
/** "replace": only Copilot's categories are left. "keep": a category Copilot
 *  doesn't use stays while it still holds something. */
export type CategoryMode = "replace" | "keep";

/** "Oct 24, 2026" for "2026-10-24". */
function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

const transactions = (n: number) => `${n} ${n === 1 ? "transaction" : "transactions"}`;

/** Which categories the import deletes, and which it keeps only for rows
 *  Copilot doesn't cover (or for split pieces and budgets), once the rows in
 *  `removing` are removed. Replacing all deletes every one of them but those
 *  in `keeping`, and `uncategorised` counts the rows that lose their category
 *  with it. */
export function categoryEffects(
  plan: CopilotPlan, removing: Set<number>, replaceAll = false, keeping: Set<string> = new Set(),
) {
  const removes: string[] = [];
  const kept: { name: string; rows: number }[] = [];
  let uncategorised = 0;
  for (const h of plan.category_holds) {
    const rows = h.kept_rows + h.removable.filter((id) => !removing.has(id)).length;
    if (replaceAll && keeping.has(h.name)) {
      kept.push({ name: h.name, rows });
    } else if (replaceAll) {
      removes.push(h.name);
      uncategorised += rows;
    } else if (rows === 0 && h.pinned === 0) {
      removes.push(h.name);
    } else {
      kept.push({ name: h.name, rows });
    }
  }
  return { removes, kept, uncategorised };
}

/** The "Import from Copilot" card's markup. Props only, so it can be tested
 *  without Tauri; `CopilotImportCard` wires it to the real calls. */
export function CopilotImportPanel({
  plan, result, busy, onChoose, onImport, removeIds, onToggleRemove, onSetAllRemove, mode, onModeChange,
  categoryMode, onCategoryModeChange, keepNames, onToggleKeep,
}: CopilotImportPanelProps) {
  const effects = plan
    ? categoryEffects(plan, mode === "remove" ? removeIds : new Set<number>(), categoryMode === "replace", keepNames)
    : null;
  return (
    <Card title="Import from Copilot"
      subtitle="Bring your Copilot categories, notes and history into Tally, once, so you can stop using Copilot.">
      <div className="grid" style={{ gap: 12 }}>
        {result ? (
          <div className="notice pos">
            {result.matched} matched, {result.added} added, {result.categories} categories created,{" "}
            {result.rules} rules learned, {result.removed} removed. A backup was taken first, so this can be
            undone from Backups, and any removed transaction can be restored from Spending.
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            In Copilot, go to Settings → Account → <strong>Export your transactions</strong>, save the
            file, then choose it here. Nothing changes until you press Import.
          </p>
        )}

        <div className="row center" style={{ gap: 8 }}>
          <Button variant={plan ? "secondary" : "primary"} onClick={onChoose} disabled={busy}>
            Choose Copilot export…
          </Button>
          {plan && !result && <Button onClick={onImport} loading={busy}>Import</Button>}
        </div>

        {plan && !result && (
          <div className="grid" style={{ gap: 6, fontSize: 13 }}>
            <div><strong>{plan.matches.length} matched</strong> to transactions Tally already has, which get your Copilot category</div>
            <div><strong>{plan.additions.length} added as history</strong> from before Tally's own records</div>
            {plan.skipped.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer" }}>
                  {plan.skipped.length} not matched (Tally's own record differs), skipped
                </summary>
                <div className="grid" style={{ gap: 2, paddingTop: 6 }}>
                  {plan.skipped.map((s, i) => (
                    <div key={i} className="muted">{fmtDate(s.date)} · {s.name} · {money(s.amount)} · {s.account}</div>
                  ))}
                </div>
              </details>
            )}
            {plan.not_in_copilot.length > 0 && (
              <div className="grid" style={{ gap: 6, paddingTop: 4 }}>
                <div className="row center" style={{ gap: 10 }}>
                  <strong>{plan.not_in_copilot.length} not in Copilot</strong>
                  <Segmented<NotInCopilotMode> value={mode} onChange={onModeChange} items={[
                    { value: "remove", label: "Remove them" },
                    { value: "keep", label: "Keep them" },
                  ]} />
                </div>
                {mode === "keep" ? (
                  <div className="muted">They stay in your transactions.</div>
                ) : (
                  <>
                    <div className="muted">
                      Like deleting in Copilot: {removeIds.size} ticked leave Spending. Restore any later.
                      <button className="btn btn-ghost btn-sm" onClick={() => onSetAllRemove(true)}>Tick all</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => onSetAllRemove(false)}>Tick none</button>
                    </div>
                    <div className="grid" style={{ gap: 2, maxHeight: 260, overflow: "auto" }}>
                      {plan.not_in_copilot.map((n) => (
                        <label key={n.txn_id} className="row center" style={{ gap: 8, fontSize: 12 }}>
                          <input type="checkbox" checked={removeIds.has(n.txn_id)} onChange={() => onToggleRemove(n.txn_id)} />
                          <span>
                            {fmtDate(n.date)} · {n.name} · {money(n.amount)} · <span className="muted">{n.account}</span>
                            {n.earlier_export && (
                              <span className="muted"> · From an earlier Copilot export; Copilot no longer has it</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {plan.pending_or_excluded > 0 && (
              <div className="muted">{plan.pending_or_excluded} pending or excluded in Copilot, skipped</div>
            )}
            {plan.new_categories.length > 0 && (
              <div>New categories: {plan.new_categories.map((c) => c.name).join(", ")}</div>
            )}
            <div className="row center" style={{ gap: 10, paddingTop: 4 }}>
              <strong>Categories</strong>
              <Segmented<CategoryMode> value={categoryMode} onChange={onCategoryModeChange} items={[
                { value: "replace", label: "Only Copilot's" },
                { value: "keep", label: "Keep ones still in use" },
              ]} />
            </div>
            {plan.merges.length > 0 && (
              <div>Renames and merges: {plan.merges.map(([from, to]) => `${from} → ${to}`).join(", ")}</div>
            )}
            {categoryMode === "replace" && plan.category_holds.length > 0 && (
              <div className="grid" style={{ gap: 4 }}>
                <div>
                  Removes every category Copilot doesn't use. Tick any to keep: Copilot's export leaves out a
                  category no transaction is in.
                </div>
                {plan.category_holds.map((h) => {
                  const rows = h.kept_rows + h.removable.filter((id) => mode !== "remove" || !removeIds.has(id)).length;
                  return (
                    <label key={h.name} className="row center" style={{ gap: 8, fontSize: 12 }}>
                      <input type="checkbox" checked={keepNames.has(h.name)} onChange={() => onToggleKeep(h.name)}
                        aria-label={`Keep ${h.name}`} />
                      <span>{h.name}{rows > 0 && <span className="muted"> · {transactions(rows)}</span>}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {categoryMode === "keep" && effects && effects.removes.length > 0 && (
              <div>Removes categories no longer used: {effects.removes.join(", ")}</div>
            )}
            {effects && effects.uncategorised > 0 && (
              <div className="muted">
                {transactions(effects.uncategorised)} in the removed ones{" "}
                {effects.uncategorised === 1 ? "becomes uncategorised and goes" : "become uncategorised and go"} back to To review
              </div>
            )}
            {categoryMode === "keep" && effects?.kept.map((k) => (
              <div key={k.name} className="muted">
                Kept: {k.name} — {k.rows > 0 ? `${transactions(k.rows)} Copilot doesn't cover` : "used by splits or budgets"}
              </div>
            ))}
            <div>
              {transactions(plan.recategorised)} {plan.recategorised === 1 ? "gets" : "get"} Copilot's category
            </div>
            {plan.untouched_after_cutoff > 0 && (
              <div className="muted">
                {transactions(plan.untouched_after_cutoff)} after {longDate(plan.cutoff)} keep their categories{" "}
                {categoryMode === "replace" ? "(renames aside, unless the category goes)" : "(renames aside)"}
              </div>
            )}
            <div>{plan.rules.length} payee rules learned from how you categorised in Copilot</div>
            {plan.rules.length > 0 && (
              <div className="muted">Rules learned from Copilot will also sort new transactions from your bank from now on.</div>
            )}
            <details>
              <summary style={{ cursor: "pointer" }}>Accounts</summary>
              <div className="grid" style={{ gap: 2, paddingTop: 6 }}>
                {plan.accounts.map(([from, to]) => (
                  <div key={from} className="muted">{from} → {to}</div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </Card>
  );
}
