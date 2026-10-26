import { Fragment, useEffect, useState } from "react";
import { useSetTransactionCategory } from "../../data/queries";
import { useOfferUndo } from "../../data/undo";
import { splitRemainder } from "../../domain/splits";
import { money, fmtDate } from "../../ui/format";
import { Badge } from "../../ui/components";
import { SplitEditor } from "./SplitEditor";
import type { Account, BankTransaction, Category } from "../../domain/types";

/**
 * The month's transactions with an inline category picker. Changing a category
 * marks that row as chosen by hand, and can teach Tally to do the same for
 * everything else from that payee. Split opens an editor beneath a row that
 * divides it across categories; a split row lists its pieces in place of the
 * picker.
 */
export function TransactionList({ transactions, categories, accounts, colourOf, onApprove, onRemove, onRestore }: {
  transactions: BankTransaction[];
  categories: Category[];
  accounts: Account[];
  colourOf: (token: string) => string;
  /** Offered on the To review list: accept a row as it is. */
  onApprove?: (id: number) => void;
  /** Take a row out of Spending — the owner was paid back. Restorable. */
  onRemove?: (id: number) => void;
  /** Put a removed row back. */
  onRestore?: (id: number) => void;
}) {
  const setCategory = useSetTransactionCategory();
  const offerUndo = useOfferUndo();
  const [teaching, setTeaching] = useState<number | null>(null);
  const [splitting, setSplitting] = useState<number | null>(null);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "—";
  // An editor must not outlive its row: the list changes under it on a month
  // change or a sync, and the row could come back with the editor still open.
  useEffect(() => {
    if (splitting != null && !transactions.some((t) => t.id === splitting)) setSplitting(null);
  }, [transactions, splitting]);
  const openSplit = (id: number) => { setTeaching(null); setSplitting(id); };
  const columns = 5 + (onApprove ? 1 : 0) + (onRemove || onRestore ? 1 : 0);

  function choose(t: BankTransaction, value: string) {
    const categoryId = value === "" ? null : Number(value);
    const payee = t.payee?.trim();
    // Offering to learn only makes sense when there is a payee to key off.
    if (categoryId != null && payee) {
      setTeaching(t.id);
    }
    // t is the row as it was before the change: exactly what Undo puts back.
    setCategory.mutate(
      { id: t.id, categoryId, applyToPayee: false },
      { onSuccess: () => offerUndo("Category changed", [t]) },
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="left">Date</th>
            <th className="left">Description</th>
            <th className="left">Account</th>
            <th className="left">Category</th>
            <th>Amount</th>
            {onApprove && <th />}
            {(onRemove || onRestore) && <th />}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => {
            const category = t.category_id == null ? null : byId.get(t.category_id) ?? null;
            const incoming = t.amount > 0;
            const name = t.payee ?? t.description;
            const remainder = splitRemainder(t);
            return (
              <Fragment key={t.id}>
                <tr>
                  <td className="left">{fmtDate(t.posted)}</td>
                  <td className="left">
                    <div className="cell-primary">{name}</div>
                    {t.payee && t.description !== t.payee && (
                      <div className="cell-secondary">{t.description}</div>
                    )}
                    {t.note && <div className="cell-secondary" style={{ fontStyle: "italic" }}>{t.note}</div>}
                    {t.pending && <Badge tone="warn">Pending</Badge>}
                  </td>
                  <td className="left cell-secondary">{accountName(t.account_id)}</td>
                  <td className="left">
                    {t.splits.length > 0 ? (
                      <div style={{ display: "grid", gap: 3 }}>
                        {t.splits.map((s) => {
                          const c = s.category_id == null ? null : byId.get(s.category_id) ?? null;
                          return (
                            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                              <span style={{
                                width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                                background: c ? colourOf(c.colour) : "var(--line)",
                              }} />
                              <span>{c?.name ?? "Uncategorised"}</span>
                              <span className="muted n">{money(Math.abs(s.amount))}</span>
                            </div>
                          );
                        })}
                        {remainder !== 0 && (
                          <div className="cell-secondary">
                            {Math.sign(remainder) === Math.sign(t.amount)
                              ? `${money(Math.abs(remainder))} not assigned — the bank changed the amount`
                              : `The pieces are ${money(Math.abs(remainder))} more than the bank's amount — edit the split`}
                          </div>
                        )}
                        {!t.removed && (
                          <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start", padding: "2px 0" }}
                            aria-label={`Edit split for ${name}`} aria-expanded={splitting === t.id}
                            onClick={() => openSplit(t.id)}>
                            Edit split
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          {category && (
                            <span style={{
                              width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                              background: colourOf(category.colour),
                            }} />
                          )}
                          <select
                            value={t.category_id ?? ""}
                            onChange={(e) => choose(t, e.target.value)}
                            aria-label={`Category for ${name}`}
                            style={{ padding: "4px 6px", fontSize: 12, maxWidth: 168 }}
                          >
                            <option value="">Uncategorised</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                          {t.category_source === "manual" && (
                            <span className="muted" style={{ fontSize: 10 }} title="You chose this category">·</span>
                          )}
                          {!t.reviewed && (
                            <span title="To review" aria-label="To review" style={{
                              width: 6, height: 6, borderRadius: 3, background: "var(--accent)", flexShrink: 0,
                            }} />
                          )}
                          {!t.removed && (
                            <button className="btn btn-ghost btn-sm" aria-label={`Split ${name}`} aria-expanded={splitting === t.id}
                              title="Split across categories" onClick={() => openSplit(t.id)}>Split</button>
                          )}
                        </div>
                        {teaching === t.id && t.payee && (
                          <div className="row center" style={{ gap: 8, marginTop: 6 }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => {
                              setCategory.mutate({ id: t.id, categoryId: t.category_id, applyToPayee: true });
                              setTeaching(null);
                            }}>
                              Apply to all “{t.payee}”
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setTeaching(null)}>Just this one</button>
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className={incoming ? "pos" : undefined} style={{ fontWeight: 600 }}>
                    {incoming ? "+" : ""}{money(t.amount)}
                  </td>
                  {onApprove && (
                    <td>
                      <button className="btn btn-ghost btn-sm" aria-label={`Approve ${name}`}
                        title="Looks right" onClick={() => onApprove(t.id)}>✓</button>
                    </td>
                  )}
                  {(onRemove || onRestore) && (
                    <td>
                      {t.removed ? (
                        onRestore && (
                          <button className="btn btn-ghost btn-sm" aria-label={`Restore ${name}`}
                            onClick={() => onRestore(t.id)}>Restore</button>
                        )
                      ) : (
                        onRemove && (
                          <button className="btn btn-ghost btn-sm" aria-label={`Remove ${name}`}
                            title="Remove from spending (paid back)" onClick={() => onRemove(t.id)}>×</button>
                        )
                      )}
                    </td>
                  )}
                </tr>
                {splitting === t.id && (
                  <tr>
                    <td className="left" colSpan={columns}>
                      <SplitEditor txn={t} categories={categories} onDone={() => setSplitting(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
