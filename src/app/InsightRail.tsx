import { useState } from "react";
import { Link } from "react-router-dom";
import { usePortfolio } from "../data/usePortfolio";
import { useTransactions, useSecurities, usePreviousPrices, useSimplefinStatus } from "../data/queries";
import { readLastSync } from "../data/lastSync";
import { buildMovers, attentionItems } from "../domain/movers";
import { money, pct, fmtDate } from "../ui/format";
import { useChartColors } from "../ui/chartColors";
import { Badge } from "../ui/components";
import { Icons } from "./icons";
import type { Transaction, TxnType } from "../domain/types";

type Tab = "activity" | "movers" | "accounts";

const INFLOW: TxnType[] = ["deposit", "dividend", "interest", "sell"];

function txnLabel(t: Transaction, ticker: string | null): string {
  const kind = t.type.charAt(0).toUpperCase() + t.type.slice(1);
  return ticker ? `${kind} · ${ticker}` : kind;
}

function txnAmount(t: Transaction): number {
  if (t.type === "buy" || t.type === "sell") return t.quantity * t.price;
  return t.amount;
}

export function InsightRail() {
  const [tab, setTab] = useState<Tab>("activity");
  const { holdings, accountValues, accounts, isLoading } = usePortfolio();
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: previous = [] } = usePreviousPrices();
  const { data: status } = useSimplefinStatus();
  const colors = useChartColors();

  const tickerOf = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? null;
  const movers = buildMovers(holdings, new Map(previous));
  const attention = attentionItems({
    accounts,
    holdings,
    connected: status?.connected ?? false,
    skippedHoldings: readLastSync()?.holdings_skipped ?? 0,
  });

  const recent = [...txns]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 6);

  const ranked = accounts
    .map((a) => ({ account: a, value: accountValues.get(a.id) ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const largest = ranked.reduce((m, r) => Math.max(m, Math.abs(r.value)), 0);

  return (
    <aside className="insight" aria-label="Side panel">
      <div className="insight-tabs">
        <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity</button>
        <button className={tab === "movers" ? "on" : ""} onClick={() => setTab("movers")}>Movers</button>
        <button className={tab === "accounts" ? "on" : ""} onClick={() => setTab("accounts")}>Accounts</button>
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
          <div className="cap" style={{ marginBottom: 12 }}>Recent</div>
          {isLoading ? <p className="muted">Loading…</p> : recent.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>
              Nothing recorded yet. <Link to="/activity">Add a transaction</Link>.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 13 }}>
              {recent.map((t) => {
                const inflow = INFLOW.includes(t.type);
                const ticker = tickerOf(t.security_id);
                return (
                  <div className="feed-row" key={t.id}>
                    <span className="feed-icon" style={{
                      background: inflow ? "var(--pos-soft)" : "var(--accent-soft)",
                      color: inflow ? "var(--pos)" : "var(--accent)",
                    }}>
                      {inflow ? <Icons.up size={13} /> : <Icons.down size={13} />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, display: "block" }}>{txnLabel(t, ticker)}</span>
                      <span className="cell-secondary">{fmtDate(t.date)}</span>
                    </span>
                    <span className="n" style={{ marginLeft: "auto", fontWeight: 600, color: inflow ? "var(--pos)" : undefined }}>
                      {inflow ? "+" : ""}{money(txnAmount(t))}
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
