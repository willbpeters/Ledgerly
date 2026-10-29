import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePortfolio } from "../data/usePortfolio";
import { useTransactions, useSecurities, usePreviousPrices, useSimplefinStatus, useBankTransactions } from "../data/queries";
import { readLastSync } from "../data/lastSync";
import { buildMovers, attentionItems } from "../domain/movers";
import { activityWindowStart, recentActivity } from "../domain/overview";
import { localIsoDate } from "../domain/dates";
import { money, pct, fmtDate } from "../ui/format";
import { useChartColors } from "../ui/chartColors";
import { Badge } from "../ui/components";
import { Icons } from "./icons";
import { WindowControls } from "./WindowControls";

type Tab = "activity" | "movers" | "accounts";

/** How far back Recent looks, and how many rows it shows. */
const RECENT_DAYS = 30;
const RECENT_ROWS = 6;

export function InsightRail() {
  const [tab, setTab] = useState<Tab>("activity");
  const { holdings, accountValues, accounts, isLoading } = usePortfolio();
  const today = localIsoDate();
  const { data: bankTxns = [] } = useBankTransactions(activityWindowStart(today, RECENT_DAYS), today);
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: previous = [] } = usePreviousPrices();
  const { data: status } = useSimplefinStatus();
  const colors = useChartColors();

  const movers = buildMovers(holdings, new Map(previous));
  const attention = attentionItems({
    accounts,
    holdings,
    connected: status?.connected ?? false,
    skippedHoldings: readLastSync()?.holdings_skipped ?? 0,
  });

  // Synced bank and card activity alongside investment trades, as on the Dashboard.
  const recent = useMemo(
    () => recentActivity({ bankTxns, txns, accounts, securities, today, days: RECENT_DAYS }).slice(0, RECENT_ROWS),
    [bankTxns, txns, accounts, securities, today],
  );

  const ranked = accounts
    .map((a) => ({ account: a, value: accountValues.get(a.id) ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const largest = ranked.reduce((m, r) => Math.max(m, Math.abs(r.value)), 0);

  return (
    <aside className="insight" aria-label="Side panel">
      <div className="insight-tabs" data-tauri-drag-region>
        <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity</button>
        <button className={tab === "movers" ? "on" : ""} onClick={() => setTab("movers")}>Movers</button>
        <button className={tab === "accounts" ? "on" : ""} onClick={() => setTab("accounts")}>Accounts</button>
        <WindowControls />
      </div>

      {attention.length > 0 && (
        <div className="insight-block">
          <div className="cap" style={{ marginBottom: 12 }}>Needs attention</div>
          <div style={{ display: "grid", gap: 8 }}>
            {attention.map((a) => (
              <div key={a.id} className={`notice ${a.tone}`} style={{ display: "flex", gap: 10 }}>
                <span style={{ flexShrink: 0, marginTop: 1 }}><Icons.alert size={15} /></span>
                <span>
                  <span style={{ fontWeight: 600, display: "block" }}>{a.title}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{a.body}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div className="insight-block">
          <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12 }}>
            <div className="cap">Recent</div>
            {recent.length > 0 && <Link to="/spending" style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600 }}>View all</Link>}
          </div>
          {isLoading ? <p className="muted">Loading…</p> : recent.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>
              Nothing in the last {RECENT_DAYS} days. Sync your banks, or <Link to="/activity">add a transaction</Link>.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 13 }}>
              {recent.map((r) => {
                const inflow = r.amount > 0;
                return (
                  <div className="feed-row" key={r.key}>
                    <span className="feed-icon" style={{
                      background: inflow ? "var(--pos-soft)" : "var(--accent-soft)",
                      color: inflow ? "var(--pos)" : "var(--accent)",
                    }}>
                      {inflow ? <Icons.up size={13} /> : <Icons.down size={13} />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.description}
                      </span>
                      <span className="cell-secondary">
                        {fmtDate(r.date)} · {r.account}{r.pending && " · Pending"}
                      </span>
                    </span>
                    <span className="n" style={{ marginLeft: "auto", fontWeight: 600, color: inflow ? "var(--pos)" : undefined }}>
                      {inflow ? "+" : ""}{money(r.amount)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "movers" && (
        <div className="insight-block">
          <div className="cap" style={{ marginBottom: 12 }}>Today's moves</div>
          {movers.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>No previous close to compare against yet.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {movers.map((m) => (
                <div key={m.security_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 46, fontWeight: 600 }}>{m.ticker}</span>
                  <span className="bar-track" style={{ flex: 1, width: "auto" }}>
                    <span className="bar-fill" style={{
                      width: `${Math.max(3, m.weight * 100)}%`,
                      background: m.change >= 0 ? "var(--pos)" : "var(--neg)",
                    }} />
                  </span>
                  <span className="n" style={{ width: 96, textAlign: "right", fontSize: 12, color: m.change >= 0 ? "var(--pos)" : "var(--neg)" }}>
                    {m.change >= 0 ? "+" : ""}{money(m.change)}
                    <span className="muted" style={{ marginLeft: 5 }}>{pct(m.changePct)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "accounts" && (
        <div className="insight-block">
          <div className="cap" style={{ marginBottom: 12 }}>By account</div>
          {ranked.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>
              No accounts yet. <Link to="/accounts">Add one</Link>.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 13 }}>
              {ranked.map(({ account, value }, i) => (
                <div key={account.id}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{account.name}</span>
                    {account.source === "simplefin" && <Badge tone="accent">SimpleFIN</Badge>}
                    <span className="n" style={{ marginLeft: "auto", fontWeight: 600 }}>{money(value)}</span>
                  </div>
                  <span className="bar-track" style={{ display: "block", width: "100%", marginTop: 6 }}>
                    <span className="bar-fill" style={{
                      width: `${largest > 0 ? Math.max(2, (Math.abs(value) / largest) * 100) : 0}%`,
                      background: colors.series[i % colors.series.length],
                    }} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
