import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Card } from "../../ui/components";
import { ThemeToggle } from "../../ui/ThemeToggle";
import { SimplefinCard } from "./SimplefinCard";
import { BackupCard } from "./BackupCard";
import { DeviceSyncCard } from "./DeviceSyncCard";
import { CopilotImportCard } from "./CopilotImportCard";

// Categories and rules live in Spending, and refreshing prices in Markets.
export function Settings() {
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

      <SimplefinCard />
      <CopilotImportCard />
      <BackupCard />
      <DeviceSyncCard />

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
