import { Card, Button, EmptyState } from "../../ui/components";
import { DataTable } from "../../ui/DataTable";
import { kindLabel, formatBytes, whenLabel } from "../../domain/backup";
import type { BackupEntry, BackupStatus } from "../../domain/types";

export interface BackupPanelProps {
  status: BackupStatus;
  backups: BackupEntry[];
  /** Local ISO date, for "Today" and "Yesterday". */
  today: string;
  busy: { backingUp: boolean; exporting: boolean; restoring: boolean };
  exportedTo: string | null;
  onBackUpNow: () => void;
  onChooseExtra: () => void;
  onRemoveExtra: () => void;
  onRestore: (entry: BackupEntry) => void;
  onRestoreFromFile: () => void;
  onExport: () => void;
  onRevealExport: () => void;
}

/** The Backups card's markup. Takes everything as props so it can be tested
 *  without Tauri; `BackupCard` wires it to the real calls. */
export function BackupPanel(p: BackupPanelProps) {
  const { status, backups, today, busy } = p;
  const latest = status.latest
    ? `${whenLabel(status.latest.date, status.latest.time, today)} (${kindLabel(status.latest.kind).toLowerCase()})`
    : "none yet";
  const failure = status.last_attempt?.error;
  const warning = status.last_attempt?.warning;

  return (
    <Card title="Backups" subtitle="Copies of your data, made automatically each day you open Ledgerly.">
      {status.restore_error && <p className="neg" role="alert">Restore didn't happen: {status.restore_error}</p>}
      {failure && <p className="neg" role="alert">Last backup failed: {failure}</p>}
      {warning && <p className="muted">{warning}</p>}

      <div className="row center" style={{ gap: 12 }}>
        <span>Last backup: {latest}</span>
        <Button onClick={p.onBackUpNow} loading={busy.backingUp}>Back up now</Button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="row center" style={{ gap: 8 }}>
          <span className="muted">Extra copy folder</span>
          <code>{status.extra_folder ?? "None"}</code>
          <Button variant="secondary" size="sm" onClick={p.onChooseExtra}>Choose…</Button>
          {status.extra_folder && <Button variant="ghost" size="sm" onClick={p.onRemoveExtra}>Remove</Button>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Each backup is also copied here, such as a USB drive or a cloud folder. Until encryption arrives,
          a cloud folder holds your finances unencrypted.
        </p>
      </div>

      <div style={{ marginTop: 16 }}>
        {backups.length === 0 ? (
          <EmptyState title="No backups yet" body="One is made the next time Ledgerly opens, or now with Back up now." />
        ) : (
          <DataTable
            rows={backups}
            getKey={(b) => b.file_name}
            columns={[
              { key: "when", label: "When", align: "left", render: (b) => whenLabel(b.date, b.time, today) },
              { key: "kind", label: "Kind", align: "left", render: (b) => kindLabel(b.kind) },
              { key: "size", label: "Size", render: (b) => formatBytes(b.size) },
              {
                key: "restore", label: "",
                render: (b) => (
                  <Button variant="ghost" size="sm" disabled={busy.restoring} onClick={() => p.onRestore(b)}>Restore</Button>
                ),
              },
            ]}
          />
        )}
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" disabled={busy.restoring} onClick={p.onRestoreFromFile}>
            Restore from a file…
          </Button>
        </div>
      </div>

      <div className="row center" style={{ gap: 12, marginTop: 16 }}>
        <Button variant="secondary" onClick={p.onExport} loading={busy.exporting}>Export to CSV…</Button>
        {p.exportedTo && (
          <>
            <span className="pos">Exported to {p.exportedTo}</span>
            <Button variant="ghost" size="sm" onClick={p.onRevealExport}>Show in folder</Button>
          </>
        )}
      </div>
    </Card>
  );
}
