import { useAccounts, useDeleteAccount } from "../../data/queries";
import { AccountForm } from "./AccountForm";

export function Accounts() {
  const { data: accounts = [], isLoading } = useAccounts();
  const del = useDeleteAccount();

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Accounts</h1>
      <div className="card"><AccountForm /></div>
      <div className="card">
        {isLoading ? <p>Loading…</p> : accounts.length === 0 ? (
          <p>No accounts yet. Add one above.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Institution</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td><td>{a.type}</td><td>{a.institution ?? "—"}</td>
                  <td><button className="secondary" onClick={() => {
                    if (confirm(`Delete "${a.name}"? This removes its transactions.`)) del.mutate(a.id);
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
