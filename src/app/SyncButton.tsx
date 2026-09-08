import { useSimplefinStatus, useSimplefinSync } from "../data/queries";
import { Button } from "../ui/components";
import { useToast } from "../ui/toast";
import { timeAgo } from "../ui/format";
import { Icons } from "./icons";

export function SyncButton() {
  const { data: status } = useSimplefinStatus();
  const sync = useSimplefinSync();
  const toast = useToast();
  if (!status?.connected) return null;

  function run() {
    sync.mutate(undefined, {
      onSuccess: (r) => toast.push({
        tone: r.errors.length ? "neutral" : "pos",
        title: `Synced ${r.accounts_synced} account${r.accounts_synced === 1 ? "" : "s"}`,
        body: [r.holdings_synced ? `${r.holdings_synced} holdings` : "", r.errors[0] ?? ""].filter(Boolean).join(" · "),
      }),
      onError: (e) => toast.push({ tone: "neg", title: "Sync failed", body: String(e) }),
    });
  }

  return (
    <div className="grid" style={{ gap: 4 }}>
      <Button variant="secondary" size="sm" block loading={sync.isPending} onClick={run}>
        <Icons.sync /> Sync SimpleFIN
      </Button>
      <div className="muted" style={{ fontSize: 11, textAlign: "center" }}>Last synced {timeAgo(status.last_synced_at)}</div>
    </div>
  );
}
