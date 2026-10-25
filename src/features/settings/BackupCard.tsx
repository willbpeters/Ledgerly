import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../data/api";
import {
  useBackupStatus, useBackupList, useBackupNow, useSetExtraFolder, useRestoreBackup, useExportCsv,
} from "../../data/queries";
import { localIsoDate } from "../../domain/dates";
import { whenLabel } from "../../domain/backup";
import { useToast } from "../../ui/toast";
import { askToConfirm } from "../../ui/confirm";
import { BackupPanel } from "./BackupPanel";

export function BackupCard() {
  const status = useBackupStatus();
  const list = useBackupList();
  const backUp = useBackupNow();
  const setExtra = useSetExtraFolder();
  const restore = useRestoreBackup();
  const exportCsv = useExportCsv();
  const toast = useToast();
  const today = localIsoDate();

  if (!status.data) return null;

  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });

  // On success the app restarts, so only failure needs handling here.
  const restoreFrom = async (path: string, what: string) => {
    const ok = await askToConfirm(
      `Replace everything in Tally with ${what}?\n\nYour current data is backed up first, so this can be undone. Tally restarts to finish.`,
      { okLabel: "Restore", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    restore.mutate(path, { onError: failed("Restore didn't happen") });
  };

  return (
    <BackupPanel
      status={status.data}
      backups={list.data ?? []}
      today={today}
      busy={{ backingUp: backUp.isPending, exporting: exportCsv.isPending, restoring: restore.isPending }}
      exportedTo={exportCsv.data ?? null}
      onBackUpNow={() => backUp.mutate(undefined, {
        onSuccess: () => toast.push({ tone: "pos", title: "Backed up" }),
        onError: failed("Backup failed"),
      })}
      onChooseExtra={async () => {
        const folder = await open({ directory: true, title: "Choose a folder for extra backup copies" });
        if (typeof folder === "string") setExtra.mutate(folder, { onError: failed("Couldn't save that folder") });
      }}
      onRemoveExtra={() => setExtra.mutate(null, { onError: failed("Couldn't remove that folder") })}
      onRestore={(b) => restoreFrom(b.path, `the backup from ${whenLabel(b.date, b.time, today)}`)}
      onRestoreFromFile={async () => {
        const file = await open({
          title: "Choose a Tally backup",
          filters: [{ name: "Tally backup", extensions: ["sqlite"] }],
        });
        if (typeof file === "string") restoreFrom(file, `the backup in ${file}`);
      }}
      onExport={async () => {
        const folder = await open({ directory: true, title: "Choose where to save the export" });
        if (typeof folder === "string") exportCsv.mutate(folder, { onError: failed("Export failed") });
      }}
      onRevealExport={() => {
        if (exportCsv.data) api.backup.reveal(exportCsv.data).catch(failed("Couldn't open the folder"));
      }}
    />
  );
}
