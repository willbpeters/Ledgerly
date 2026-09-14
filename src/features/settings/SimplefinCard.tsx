import { useState } from "react";
import { useSimplefinStatus, useSimplefinConnect, useSimplefinSync, useSimplefinDisconnect, useSimplefinBackfill, useSimplefinDiagnose } from "../../data/queries";
import { Card, Button, Badge } from "../../ui/components";
import { timeAgo } from "../../ui/format";
import type { SyncReport, SimplefinSample } from "../../domain/types";

// SimpleFIN's public demo. Its shared *setup token* is permanently claimed and
// answers 403 to everyone, so the demo uses the access URL, which Ledgerly
// accepts directly. Three sample cash accounts, no holdings.
const DEMO_ACCESS_URL = "https://demo:demo@beta-bridge.simplefin.org/simplefin";

function Report({ r }: { r: SyncReport }) {
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="notice pos">
        Synced {r.accounts_synced} account{r.accounts_synced === 1 ? "" : "s"} and {r.holdings_synced} holding{r.holdings_synced === 1 ? "" : "s"}.
        {r.transactions_added > 0 && ` Imported ${r.transactions_added} new transaction${r.transactions_added === 1 ? "" : "s"}.`}
        {r.holdings_skipped > 0 && ` ${r.holdings_skipped} holding${r.holdings_skipped === 1 ? "" : "s"} had no ticker symbol and were skipped.`}
      </div>
      {r.accounts_removed > 0 && (
        <div className="notice warn">
          Removed {r.accounts_removed} account{r.accounts_removed === 1 ? "" : "s"} you no
          longer share with SimpleFIN, along with their transactions.
        </div>
      )}
      {r.errors.map((e, i) => <div key={i} className="notice warn">{e}</div>)}
    </div>
  );
}

export function SimplefinCard() {
  const { data: status, isLoading } = useSimplefinStatus();
  const connect = useSimplefinConnect();
  const sync = useSimplefinSync();
  const disconnect = useSimplefinDisconnect();
  const backfill = useSimplefinBackfill();
  const diagnose = useSimplefinDiagnose();
  const [sample, setSample] = useState<SimplefinSample | null>(null);
  const [copied, setCopied] = useState("");
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
  function doDiagnose() {
    setError(""); setReport(null); setSample(null); setCopied("");
    diagnose.mutate(undefined, {
      onSuccess: setSample,
      onError: (e) => setError(String(e)),
    });
  }
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Couldn't copy to the clipboard. Select the text below and copy it manually.");
    }
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
            <Button variant="secondary" loading={backfill.isPending} onClick={() => {
              setError(""); setReport(null);
              backfill.mutate(730, { onSuccess: setReport, onError: (e) => setError(String(e)) });
            }}>Import 2 years</Button>
            <Button variant="danger" onClick={doDisconnect} loading={disconnect.isPending}>Disconnect</Button>
          </div>
          {report && <Report r={report} />}

          <details onToggle={(e) => { if (!(e.currentTarget as HTMLDetailsElement).open) setSample(null); }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Raw transaction data
            </summary>
            <div className="grid" style={{ gap: 10, paddingTop: 10 }}>
              <div className="muted">
                Shows exactly what SimpleFIN sends for a few of your recent
                transactions. Nothing is changed or uploaded — this only reads.
              </div>
              <div className="row center">
                <Button variant="secondary" onClick={doDiagnose} loading={diagnose.isPending}>
                  Show raw transaction data
                </Button>
                {sample && (
                  <>
                    <Button variant="secondary"
                      onClick={() => copy(sample.redacted, "amounts-hidden")}>
                      Copy (amounts hidden)
                    </Button>
                    <Button variant="secondary"
                      onClick={() => copy(sample.raw, "with-amounts")}>
                      Copy with amounts
                    </Button>
                    {copied && (
                      <span className="muted">
                        Copied the {copied === "amounts-hidden" ? "amounts-hidden" : "full"} version.
                      </span>
                    )}
                  </>
                )}
              </div>
              {sample && (() => {
                let n: number | null = null;
                try {
                  n = (JSON.parse(sample.raw) as { sampled: number }).sampled;
                } catch {
                  n = null;
                }
                if (n === null) return null;
                return n === 0 ? (
                  <div className="notice warn">
                    SimpleFIN returned no transactions in the last 44 days, so there is
                    nothing to inspect. This isn't an error — try again after your next
                    sync, or once some new transactions have posted.
                  </div>
                ) : (
                  <div className="muted">
                    Showing {n} transaction{n === 1 ? "" : "s"}. Look for an <code>extra</code> field —
                    that is where a bank's own category would be.
                  </div>
                );
              })()}
              {sample && (
                <pre style={{
                  maxHeight: 320, overflow: "auto", fontSize: 12, lineHeight: 1.5,
                  background: "var(--surface-2)", padding: 12, borderRadius: 8,
                  border: "1px solid var(--line)", whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>{sample.raw}</pre>
              )}
            </div>
          </details>

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
