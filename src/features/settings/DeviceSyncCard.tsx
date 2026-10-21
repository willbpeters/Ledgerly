import { open } from "@tauri-apps/plugin-dialog";
import {
  useDeviceSyncStatus, useDeviceSyncNow, useStartDeviceSync, useJoinDeviceSync, useStopDeviceSync,
} from "../../data/queries";
import { localIsoDate } from "../../domain/dates";
import { useToast } from "../../ui/toast";
import { askToConfirm } from "../../ui/confirm";
import { DeviceSyncPanel } from "./DeviceSyncPanel";

export function DeviceSyncCard() {
  const status = useDeviceSyncStatus();
  const now = useDeviceSyncNow();
  const start = useStartDeviceSync();
  const join = useJoinDeviceSync();
  const stop = useStopDeviceSync();
  const toast = useToast();

  if (!status.data) return null;
  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });
  const chooseFolder = (title: string) => open({ directory: true, title });

  return (
    <DeviceSyncPanel
      status={status.data}
      today={localIsoDate()}
      busy={now.isPending || start.isPending || join.isPending}
      onStartFirst={async () => {
        const folder = await chooseFolder("Choose where to make the Ledgerly Sync folder, e.g. My Drive");
        if (typeof folder !== "string") return;
        start.mutate(folder, {
          onSuccess: () => toast.push({ tone: "pos", title: "Sync is on", body: "Now choose Join on your other computer." }),
          onError: failed("Couldn't start syncing"),
        });
      }}
      onJoin={async () => {
        const folder = await chooseFolder("Choose the same place you picked on your other computer, or its Ledgerly Sync folder");
        if (typeof folder !== "string") return;
        const ok = await askToConfirm(
          "Replace this computer's Ledgerly data with the copy from your other computer?\n\nThis computer's data is backed up first, so this can be undone from Backups. Ledgerly restarts to finish.",
          { okLabel: "Join", cancelLabel: "Cancel" },
        );
        if (ok) join.mutate(folder, { onError: failed("Couldn't join") });
      }}
      onSyncNow={() => now.mutate(undefined, { onError: failed("Sync failed") })}
      onStop={async () => {
        const ok = await askToConfirm(
          "Stop syncing on this computer? Your data stays here; edits stop travelling between the computers.",
          { okLabel: "Stop syncing", cancelLabel: "Cancel" },
        );
        if (!ok) return;
        stop.mutate(undefined, {
          // A string means sync is off but the last edits couldn't reach the folder.
          onSuccess: (warning) => toast.push(
            warning
              ? { tone: "neg", title: "Sync is off", body: warning }
              : { tone: "pos", title: "Sync is off" },
          ),
          onError: failed("Couldn't stop syncing"),
        });
      }}
    />
  );
}
