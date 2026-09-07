import { usePortfolio } from "../../data/usePortfolio";
import { money, pct } from "../../ui/format";

export function Holdings() {
  const { holdings, isLoading } = usePortfolio();
  if (isLoading) return <p>Loading…</p>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Holdings</h1>
      <div className="card">
        {holdings.length === 0 ? <p>No holdings yet. Add a position in Activity.</p> : (
          <table>
            <thead><tr>
              <th>Ticker</th><th>Shares</th><th>Avg cost</th><th>Last</th>
              <th>Market value</th><th>Unrealized</th><th>%</th>
            </tr></thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.security_id}>
                  <td>{h.ticker}</td>
                  <td>{h.shares}</td>
                  <td>{money(h.avgCost)}</td>
                  <td>{h.lastPrice ? money(h.lastPrice) : "—"}</td>
                  <td>{money(h.marketValue)}</td>
                  <td className={h.unrealized >= 0 ? "pos" : "neg"}>{money(h.unrealized)}</td>
                  <td className={h.unrealizedPct >= 0 ? "pos" : "neg"}>{pct(h.unrealizedPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
