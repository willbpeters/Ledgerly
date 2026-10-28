import { Card, Button } from "../../ui/components";
import { money, fmtDate } from "../../ui/format";
import type { CopilotCounts, CopilotPlan } from "../../domain/types";

export interface CopilotImportPanelProps {
  /** The dry run for the chosen file, once there is one. */
  plan: CopilotPlan | null;
  result: CopilotCounts | null;
  busy: boolean;
  onChoose: () => void;
  onImport: () => void;
}

/** Copilot's name for what it excluded: the import's category for them. */
const EXCLUDED = "Excluded";

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
 *  without Tauri; `CopilotImportCard` wires it to the real calls. The import
 *  makes Tally a copy of Copilot up to the export's last day: every row,
 *  Copilot's names, and exactly Copilot's categories. */
export function CopilotImportPanel({ plan, result, busy, onChoose, onImport }: CopilotImportPanelProps) {
  return (
    <Card title="Import from Copilot"
      subtitle="Make Tally a copy of Copilot: every transaction, with Copilot's names, categories and notes.">
      <div className="grid" style={{ gap: 12 }}>
        {result ? (
          <div className="notice pos">
            {result.matched} matched, {result.added} added, {result.removed} removed, {result.categories} categories
            created, {result.rules} rules learned. A backup was taken first, so this can be undone from Backups, and
            any removed transaction can be restored from Spending.
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
            <div className="muted">Up to {longDate(plan.cutoff)}, the export's last day:</div>
            <div>
              <strong>{plan.matches.length} matched</strong> to transactions Tally already has, which take
              Copilot's name, category and note
            </div>
            <div><strong>{plan.additions.length} added</strong> that Tally doesn't have</div>
            {plan.not_in_copilot.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <strong>{plan.not_in_copilot.length} removed</strong> that Copilot doesn't have (restore any from Spending)
                </summary>
                <div className="grid" style={{ gap: 2, paddingTop: 6, maxHeight: 260, overflow: "auto" }}>
                  {plan.not_in_copilot.map((n) => (
                    <div key={n.txn_id} className="muted">
                      {fmtDate(n.date)} · {n.name} · {money(n.amount)} · {n.account}
                      {n.earlier_export && " · From an earlier Copilot export; Copilot no longer has it"}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {plan.pending > 0 && (
              <div className="muted">{transactions(plan.pending)} pending in Copilot, left for your bank sync</div>
            )}

            <div style={{ paddingTop: 4 }}>
              <strong>Categories become exactly Copilot's:</strong> {plan.export_categories.join(", ")}
            </div>
            {plan.export_categories.includes(EXCLUDED) && (
              <div className="muted">
                What you excluded in Copilot goes in {EXCLUDED}, which shows but never counts as spending
              </div>
            )}
            {plan.new_categories.length > 0 && (
              <div>New: {plan.new_categories.map((c) => c.name).join(", ")}</div>
            )}
            {plan.merges.length > 0 && (
              <div>Renamed or merged: {plan.merges.map(([from, to]) => `${from} → ${to}`).join(", ")}</div>
            )}
            {plan.deletions.length > 0 && (
              <div>Removed: {plan.deletions.join(", ")}</div>
            )}
            <div>
              {transactions(plan.recategorised)} {plan.recategorised === 1 ? "gets" : "get"} Copilot's category
            </div>
            {plan.uncategorised > 0 && (
              <div className="muted">
                {transactions(plan.uncategorised)} Copilot doesn't cover{" "}
                {plan.uncategorised === 1 ? "loses its category and goes" : "lose their category and go"} back to To review
              </div>
            )}
            {plan.untouched_after_cutoff > 0 && (
              <div className="muted">
                {transactions(plan.untouched_after_cutoff)} after {longDate(plan.cutoff)} stay as they are, apart from
                their category
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
