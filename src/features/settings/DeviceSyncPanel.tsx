import { Card, Button } from "../../ui/components";
import { whenLabel } from "../../domain/backup";
import type { DeviceSyncStatus } from "../../domain/types";

export interface DeviceSyncPanelProps {
  status: DeviceSyncStatus;
  /** Local ISO date, for "Today" and "Yesterday". */
  today: string;
  busy: boolean;
  onStartFirst: () => void;
  onJoin: () => void;
  onSyncNow: () => void;
  onStop: () => void;
}

function lastSynced(stamp: string, today: string): string {
  const [date, time] = stamp.split("T");
  return whenLabel(date, time ?? "00:00:00", today);
}

/** The card's markup. Takes everything as props so it can be tested without
 *  Tauri; `DeviceSyncCard` wires it to the real calls. */
export function DeviceSyncPanel(p: DeviceSyncPanelProps) {
  const { status, today, busy } = p;

  if (!status.enabled) {
    return (
      <Card title="Sync between computers" subtitle="Keep your budgets, categories and edits the same on your PC and laptop.">
        <p className="muted">
          Both computers need a place they can both see, such as My Drive in Google Drive. Start on the
          computer whose data you want to keep and pick that place: Tally makes a "Tally Sync" folder
          there. Then Join on the other computer and pick the same place. Joining replaces that computer's
          Tally data with a copy (backed up first).
        </p>
        <div className="row center" style={{ gap: 8, marginTop: 12 }}>
          <Button onClick={p.onStartFirst} loading={busy}>Start with this computer…</Button>
          <Button variant="secondary" onClick={p.onJoin} disabled={busy}>Join…</Button>
        </div>
      </Card>
    );
  }

  const newer = status.last?.newer_files ?? 0;
  return (
    <Card title="Sync between computers" subtitle={`This computer: ${status.this_computer}`}>
      {status.last_error && <p className="neg" role="alert">Last sync failed: {status.last_error}</p>}
      {newer > 0 && (
        <p className="neg" role="alert">
          Your other computer runs a newer version of Tally. Update this one (git pull) to take its latest edits.
        </p>
      )}

      <div className="row center" style={{ gap: 8 }}>
        <span className="muted">Folder</span>
        <code>{status.folder}</code>
      </div>

      <ul style={{ marginTop: 12 }}>
        {status.others.length === 0 ? (
          <li className="muted">Your other computer hasn't synced yet. Choose Join there with this same folder.</li>
        ) : (
          status.others.map((o) => (
            <li key={o.id}>{o.name} — last synced {lastSynced(o.last_sync, today)}</li>
          ))
        )}
      </ul>

      {status.waiting > 0 && (
        <p className="muted">
          {status.waiting} edits from your other computer are waiting for their transactions to arrive here. They
          land after this computer's next bank sync.
        </p>
      )}

      <div className="row center" style={{ gap: 8, marginTop: 12 }}>
        <Button onClick={p.onSyncNow} loading={busy}>Sync now</Button>
        {status.last && <span className="muted">Last: {lastSynced(status.last.at, today)}</span>}
        <Button variant="ghost" size="sm" onClick={p.onStop}>Stop syncing</Button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Syncs every 30 seconds while Tally is open. Until encryption arrives, the shared folder holds your
        edits unencrypted.
      </p>
    </Card>
  );
}
