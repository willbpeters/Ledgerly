import { useState } from "react";
import { useSetTransactionCategory } from "../../data/queries";
import { money, fmtDate } from "../../ui/format";
import { Badge } from "../../ui/components";
import type { Account, BankTransaction, Category } from "../../domain/types";

/**
 * The month's transactions with an inline category picker. Changing a category
 * marks that row as chosen by hand, and can teach Ledgerly to do the same for
 * everything else from that payee.
 */
export function TransactionList({ transactions, categories, accounts, colourOf }: {
  transactions: BankTransaction[];
  categories: Category[];
  accounts: Account[];
  colourOf: (token: string) => string;
}) {
  const setCategory = useSetTransactionCategory();
  const [teaching, setTeaching] = useState<number | null>(null);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "—";

  function choose(t: BankTransaction, value: string) {
    const categoryId = value === "" ? null : Number(value);
    const payee = t.payee?.trim();
    // Offering to learn only makes sense when there is a payee to key off.
    if (categoryId != null && payee) {
      setTeaching(t.id);
    }
    setCategory.mutate({ id: t.id, categoryId, applyToPayee: false });
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
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => {
            const category = t.category_id == null ? null : byId.get(t.category_id) ?? null;
            const incoming = t.amount > 0;
            return (
              <tr key={t.id}>
                <td className="left">{fmtDate(t.posted)}</td>
                <td className="left">
                  <div className="cell-primary">{t.payee ?? t.description}</div>
                  {t.payee && t.description !== t.payee && (
                    <div className="cell-secondary">{t.description}</div>
                  )}
                  {t.pending && <Badge tone="warn">Pending</Badge>}
                </td>
                <td className="left cell-secondary">{accountName(t.account_id)}</td>
                <td className="left">
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
                      aria-label={`Category for ${t.payee ?? t.description}`}
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
                </td>
                <td className={incoming ? "pos" : undefined} style={{ fontWeight: 600 }}>
                  {incoming ? "+" : ""}{money(t.amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
