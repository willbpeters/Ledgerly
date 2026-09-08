import { useRefreshPrices } from "../../data/useRefresh";
import { Card, Button } from "../../ui/components";
import { ThemeToggle } from "../../ui/ThemeToggle";
import { SimplefinCard } from "./SimplefinCard";

export function Settings() {
  const refresh = useRefreshPrices();
  return (
    <>
      <Card title="Appearance" subtitle="Light, dark, or follow Windows.">
        <ThemeToggle />
      </Card>

      <Card title="Prices" subtitle="Fetched from a free public source; only your tickers leave this machine.">
        <div className="row center">
          <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>Refresh prices now</Button>
          {refresh.isSuccess && <span className="pos">Updated {refresh.data} securities.</span>}
          {refresh.isError && <span className="neg">Couldn't refresh prices. Check your connection and try again.</span>}
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Prices also refresh automatically: every few seconds during US market hours, every 15 minutes otherwise.
        </p>
      </Card>

      <SimplefinCard />

      <Card title="About">
        <div className="grid" style={{ gap: 4, fontSize: 13 }}>
          <div><span className="muted">Version</span> · Ledgerly 0.1.0</div>
          <div><span className="muted">Data</span> · stored locally in <code>%APPDATA%\com.ledgerly.app\finance.sqlite</code></div>
          <div><span className="muted">Coming later</span> · encrypted database + app lock, budgeting</div>
        </div>
      </Card>
    </>
  );
}
