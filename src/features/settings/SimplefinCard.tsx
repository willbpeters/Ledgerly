import { useState } from "react";
import { useSimplefinStatus, useSimplefinConnect, useSimplefinSync, useSimplefinDisconnect } from "../../data/queries";
import { Card, Button, Badge } from "../../ui/components";
import { timeAgo } from "../../ui/format";
import type { SyncReport } from "../../domain/types";

// SimpleFIN's public demo. Its shared *setup token* is permanently claimed and
// answers 403 to everyone, so the demo uses the access URL, which Ledgerly
// accepts directly. Three sample cash accounts, no holdings.
const DEMO_ACCESS_URL = "https://demo:demo@beta-bridge.simplefin.org/simplefin";

function Report({ r }: { r: SyncReport }) {
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="notice pos">
        Synced {r.accounts_synced} account{r.accounts_synced === 1 ? "" : "s"} and {r.holdings_synced} holding{r.holdings_synced === 1 ? "" : "s"}.
        {r.holdings_skipped > 0 && ` ${r.holdings_skipped} holding${r.holdings_skipped === 1 ? "" : "s"} had no ticker symbol and were skipped.`}
      </div>
      {r.errors.map((e, i) => <div key={i} className="notice warn">{e}</div>)}
    </div>
  );
}

export function SimplefinCard() {
  const { data: status, isLoading } = useSimplefinStatus();
  const connect = useSimplefinConnect();
  const sync = useSimplefinSync();
  const disconnect = useSimplefinDisconnect();
  const [token, setToken] = useState("");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState("");

  function doConnect() {
    setError(""); setReport(null);
    connect.mutate(token, {
      onSuccess: (r) => { setReport(r); setToken(""); },
      onError: (e) => setError(String(e)),
    });
  }
  function doSync() {
    setError(""); setReport(null);
    sync.mutate(undefined, { onSuccess: setReport, onError: (e) => setError(String(e)) });
  }
  function doDisconnect() {
    const removeAccounts = confirm("Also remove the accounts SimpleFIN created in Ledgerly?\n\nOK = remove them and their holdings.\nCancel = keep them (they just stop updating).");
    setError(""); setReport(null);
    disconnect.mutate(removeAccounts, { onError: (e) => setError(String(e)) });
  }

  if (isLoading) return <Card title="SimpleFIN"><p className="muted">Checking connection…</p></Card>;

  if (status?.connected) {
    return (
      <Card title="SimpleFIN" subtitle="Bank and brokerage sync"
        actions={<Badge tone="pos">Connected</Badge>}>
        <div className="grid" style={{ gap: 12 }}>
          <div className="muted">Last synced {timeAgo(status.last_synced_at)}. Balances and holdings update each time you sync.</div>
          <div className="row center">
            <Button onClick={doSync} loading={sync.isPending}>Sync now</Button>
            <Button variant="danger" onClick={doDisconnect} loading={disconnect.isPending}>Disconnect</Button>
          </div>
          {report && <Report r={report} />}
          {error && <div className="notice neg">{error}</div>}
        </div>
      </Card>
    );
  }

  return (
    <Card title="SimpleFIN" subtitle="Pull balances and holdings from your banks and brokerages automatically."
      actions={<Badge>Not connected</Badge>}>
      <div className="grid" style={{ gap: 14 }}>
        <ol className="steps">
          <li>Sign up at <a href="https://bridge.simplefin.org" target="_blank" rel="noreferrer">bridge.simplefin.org</a> (about $1.50/month).</li>
          <li>Connect each bank or brokerage you want in Ledgerly.</li>
          <li>Click <strong>New Setup Token</strong>, copy it, and paste it below. Tokens work once, so make a new one if this fails.</li>
        </ol>
        <label>
          Setup token
          <textarea rows={3} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your SimpleFIN setup token here" spellCheck={false} />
          <span className="field-hint">Already have an access URL instead? Paste that here and it will be used as-is.</span>
        </label>
        <div className="row center">
          <Button onClick={doConnect} loading={connect.isPending} disabled={!token.trim()}>Connect and sync</Button>
          <Button variant="ghost" size="sm" onClick={() => setToken(DEMO_ACCESS_URL)}>Try the demo</Button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Your access credentials are kept in Windows Credential Manager, never in the database. Only account balances and holdings are downloaded.
        </p>
        {report && <Report r={report} />}
        {error && <div className="notice neg">{error}</div>}
      </div>
    </Card>
  );
}
