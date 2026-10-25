import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useRefreshPrices } from "../../data/useRefresh";
import { askBeforeRemove, setAskBeforeRemove } from "../../data/undo";
import { Card, Button } from "../../ui/components";
import { ThemeToggle } from "../../ui/ThemeToggle";
import { SimplefinCard } from "./SimplefinCard";
import { CategoriesCard } from "./CategoriesCard";
import { BackupCard } from "./BackupCard";
import { CopilotImportCard } from "./CopilotImportCard";

export function Settings() {
  const refresh = useRefreshPrices();
  const [askRemove, setAskRemove] = useState(askBeforeRemove);
  // Read from the running app, so it is right after every release.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => { /* outside the app, e.g. tests */ });
  }, []);
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

      <CopilotImportCard />

      <Card title="Spending" subtitle="Removing a transaction (when you were paid back) always offers Undo.">
        <label className="row center" style={{ gap: 8 }}>
          <input type="checkbox" checked={askRemove}
            onChange={(e) => { setAskBeforeRemove(e.target.checked); setAskRemove(e.target.checked); }} />
          Ask before removing a transaction
        </label>
      </Card>

      <CategoriesCard />

      <BackupCard />

      <Card title="About">
        <div className="grid" style={{ gap: 4, fontSize: 13 }}>
          <div><span className="muted">Version</span> · Tally {version ?? ""}</div>
          <div><span className="muted">Data</span> · stored locally in <code>%APPDATA%\com.ledgerly.app\finance.sqlite</code>, backed up to the <code>backups</code> folder beside it</div>
          <div><span className="muted">Coming later</span> · encrypted database + app lock</div>
        </div>
      </Card>
    </>
  );
}
