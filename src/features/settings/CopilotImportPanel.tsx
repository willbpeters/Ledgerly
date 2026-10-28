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
}

export type NotInCopilotMode = "remove" | "keep";

/** "Oct 24, 2026" for "2026-10-24". */
function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

const transactions = (n: number) => `${n} ${n === 1 ? "transaction" : "transactions"}`;

/** The "Import from Copilot" card's markup. Props only, so it can be tested
 *  without Tauri; `CopilotImportCard` wires it to the real calls. */
export function CopilotImportPanel({
  plan, result, busy, onChoose, onImport, removeIds, onToggleRemove, onSetAllRemove, mode, onModeChange,
}: CopilotImportPanelProps) {
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
                          <span>{fmtDate(n.date)} · {n.name} · {money(n.amount)} · <span className="muted">{n.account}</span></span>
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
            {plan.merges.length > 0 && (
              <div>Renames: {plan.merges.map(([from, to]) => `${from} → ${to}`).join(", ")}</div>
            )}
            {plan.deletions.length > 0 && (
              <div>Removes categories no longer used: {plan.deletions.join(", ")}</div>
            )}
            <div>
              {transactions(plan.recategorised)} {plan.recategorised === 1 ? "gets" : "get"} Copilot's category
            </div>
            {plan.untouched_after_cutoff > 0 && (
              <div className="muted">
                {transactions(plan.untouched_after_cutoff)} after {longDate(plan.cutoff)} are left as they are
              </div>
            )}
            <div>{plan.rules.length} payee rules learned from how you categorised in Copilot</div>
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
