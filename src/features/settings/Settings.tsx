import { useRefreshPrices } from "../../data/useRefresh";

export function Settings() {
  const refresh = useRefreshPrices();
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Settings</h1>
      <div className="card grid" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Prices</h3>
        <p style={{ color: "var(--mut)", margin: 0 }}>
          Fetch the latest closing prices for your tickers (keyless, from a free public source),
          then record today's portfolio value for the chart.
        </p>
        <div className="row">
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh prices now"}
          </button>
          {refresh.isSuccess && <span className="pos">Updated {refresh.data} securities.</span>}
          {refresh.isError && <span className="neg">Couldn't refresh prices or record today's value. Check your connection and try again.</span>}
        </div>
      </div>
      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>Coming later</h3>
        <ul style={{ color: "var(--mut)" }}>
          <li>SimpleFIN auto-sync</li>
          <li>Encrypted database + app lock (Windows Hello / passkey)</li>
          <li>Budgeting module</li>
        </ul>
      </div>
    </div>
  );
}
