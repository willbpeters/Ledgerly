import { useState } from "react";
import { useTransactions, useSecurities, useAccounts, useDeleteTransaction } from "../../data/queries";
import { AddPositionForm } from "./AddPositionForm";
import { TransactionForm } from "./TransactionForm";
import { money, fmtDate } from "../../ui/format";

export function Activity() {
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: accounts = [] } = useAccounts();
  const del = useDeleteTransaction();
  const [tab, setTab] = useState<"position" | "transaction">("position");

  const secTicker = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? "—";
  const acctName = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Activity</h1>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={tab === "position" ? "" : "secondary"} onClick={() => setTab("position")}>Quick add position</button>
          <button className={tab === "transaction" ? "" : "secondary"} onClick={() => setTab("transaction")}>Add transaction</button>
        </div>
        {tab === "position" ? <AddPositionForm /> : <TransactionForm />}
      </div>
      <div className="card">
        {txns.length === 0 ? <p>No transactions yet.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td><td>{acctName(t.account_id)}</td><td>{t.type}</td>
                  <td>{secTicker(t.security_id)}</td>
                  <td>{t.quantity || "—"}</td><td>{t.price ? money(t.price) : "—"}</td>
                  <td>{money(t.amount)}</td>
                  <td><button className="secondary" onClick={() => {
                    if (confirm("Delete this transaction? Holdings and balances will recompute.")) del.mutate(t.id);
                  }}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
