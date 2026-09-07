import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTransactions, useSecurities, useAccounts, useDeleteTransaction } from "../../data/queries";
import { AddPositionForm } from "./AddPositionForm";
import { TransactionForm } from "./TransactionForm";
import { CsvImport } from "./CsvImportForm";
import { money, fmtDate } from "../../ui/format";

export function Activity() {
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: accounts = [] } = useAccounts();
  const del = useDeleteTransaction();
  const [tab, setTab] = useState<"position" | "transaction" | "csv">("position");
  const [accountId, setAccountId] = useState<number | null>(null);

  // Default to the first account, and keep the selection valid if accounts change.
  useEffect(() => {
    if (accounts.length === 0) { setAccountId(null); return; }
    if (accountId == null || !accounts.some((a) => a.id === accountId)) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  const secTicker = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? "—";

  if (accounts.length === 0) {
    return (
      <div className="grid" style={{ gap: 16 }}>
        <h1>Activity</h1>
        <div className="card">
          <p>You need an account first. <Link to="/accounts">Create one in Accounts</Link>, then come back here.</p>
        </div>
      </div>
    );
  }

  const accountTxns = accountId == null ? [] : txns.filter((t) => t.account_id === accountId);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Activity</h1>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          Account
          <select value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>

      {accountId != null && (
        <>
          <div className="card">
            <div className="row" style={{ marginBottom: 12 }}>
              <button className={tab === "position" ? "" : "secondary"} onClick={() => setTab("position")}>Quick add position</button>
              <button className={tab === "transaction" ? "" : "secondary"} onClick={() => setTab("transaction")}>Add transaction</button>
              <button className={tab === "csv" ? "" : "secondary"} onClick={() => setTab("csv")}>Import CSV</button>
            </div>
            {tab === "position" ? <AddPositionForm accountId={accountId} />
              : tab === "transaction" ? <TransactionForm accountId={accountId} />
              : <CsvImport accountId={accountId} />}
          </div>
          <div className="card">
            {accountTxns.length === 0 ? <p>No transactions in this account yet.</p> : (
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Amount</th><th></th></tr></thead>
                <tbody>
                  {accountTxns.map((t) => (
                    <tr key={t.id}>
                      <td>{fmtDate(t.date)}</td><td>{t.type}</td>
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
        </>
      )}
    </div>
  );
}
