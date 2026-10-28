import { Link } from "react-router-dom";
import { money, fmtDate } from "../../ui/format";
import { Badge, Card, EmptyState } from "../../ui/components";
import type { ActivityRow } from "../../domain/overview";

/** Bank and investment transactions from the last week, read-only. */
export function RecentActivityCard({ rows }: { rows: ActivityRow[] }) {
  return (
    <Card title="Last 7 days" actions={<Link to="/spending" style={{ fontSize: 11, fontWeight: 600 }}>View in Spending</Link>}>
      {rows.length === 0 ? (
        <EmptyState title="No transactions in the last 7 days" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">Date</th>
                <th className="left">Description</th>
                <th className="left">Account</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="left muted">{fmtDate(r.date)}</td>
                  <td className="left">
                    <span className="cell-primary">{r.description}</span>
                    {r.pending && <> <Badge tone="warn">Pending</Badge></>}
                  </td>
                  <td className="left muted">{r.account}</td>
                  <td className={r.amount > 0 ? "pos" : undefined}>{r.amount > 0 ? "+" : ""}{money(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
