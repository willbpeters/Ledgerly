import { useState } from "react";
import { usePortfolio } from "../../data/usePortfolio";
import { useSecurities } from "../../data/queries";
import { money, pct } from "../../ui/format";
import { PageHeader, Card, Button, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import type { Holding } from "../../domain/types";

interface Row extends Holding { weight: number | null; name: string | null; }

const COLS: Column<Row>[] = [
  { key: "ticker", label: "Ticker", align: "left", render: (r) => (
      <div><div className="cell-primary">{r.ticker}</div>{r.name && <div className="cell-secondary">{r.name}</div>}</div>) },
  { key: "shares", label: "Shares", render: (r) => r.shares },
  { key: "avgCost", label: "Avg cost", render: (r) => money(r.avgCost) },
  { key: "lastPrice", label: "Last", render: (r) => (r.lastPrice ? money(r.lastPrice) : "—") },
  { key: "marketValue", label: "Market value", render: (r) => <span className="cell-primary">{money(r.marketValue)}</span> },
  { key: "unrealized", label: "Unrealized", render: (r) => money(r.unrealized), className: (r) => (r.unrealized >= 0 ? "pos" : "neg") },
  { key: "returnPct", label: "Return", render: (r) => pct(r.unrealizedPct), className: (r) => (r.unrealizedPct >= 0 ? "pos" : "neg") },
  { key: "weight", label: "Weight", render: (r) => r.weight == null ? "—" : (
      <span className="bar"><span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, r.weight)}%` }} /></span>{r.weight.toFixed(1)}%</span>) },
];

const STORAGE_KEY = "ledgerly.holdings.cols";
const TOGGLEABLE = COLS.filter((c) => c.key !== "ticker");

function loadVisible(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const known = (JSON.parse(raw) as string[]).filter((k) => TOGGLEABLE.some((c) => c.key === k));
      if (known.length) return known;
    }
  } catch { /* ignore */ }
  return TOGGLEABLE.map((c) => c.key);
}

export function Holdings() {
  const { holdings, summary, byAccount, isLoading } = usePortfolio();
  const { data: securities = [] } = useSecurities();
  const [visible, setVisible] = useState<string[]>(loadVisible);
  const [showCols, setShowCols] = useState(false);
  if (isLoading) return <p className="muted">Loading…</p>;

  const nameOf = new Map(securities.map((s) => [s.id, s.name]));
  const toRows = (hs: Holding[], denom: number): Row[] =>
    hs.map((h) => ({ ...h, name: nameOf.get(h.security_id) ?? null, weight: denom > 0 ? (h.marketValue / denom) * 100 : null }));
  const cols = COLS.filter((c) => c.key === "ticker" || visible.includes(c.key));

  function toggle(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const accountsWithHoldings = byAccount.filter((b) => b.holdings.length > 0);

  return (
    <>
      <PageHeader title="Holdings" subtitle={`${holdings.length} securities · ${money(summary.investedValue)} invested`}
        actions={
          <div style={{ position: "relative" }}>
            <Button variant="secondary" size="sm" onClick={() => setShowCols((s) => !s)}>⚙ Columns</Button>
            {showCols && (
              <div className="popover">
                {TOGGLEABLE.map((c) => (
                  <label key={c.key}>
                    <input type="checkbox" checked={visible.includes(c.key)} onChange={() => toggle(c.key)} />{c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        } />

      <Card title="All accounts">
        {holdings.length === 0
          ? <EmptyState title="No holdings yet" body="Add a position in Activity or connect SimpleFIN in Settings." />
          : <DataTable columns={cols} rows={toRows(holdings, summary.investedValue)} getKey={(r) => r.security_id} />}
      </Card>

      {accountsWithHoldings.length > 1 && accountsWithHoldings.map((b) => (
        <Card key={b.account.id} title={b.account.name}
          subtitle={`${money(b.holdingsValue)} in holdings${b.cash ? ` · ${money(b.cash)} cash` : ""}`}>
          <DataTable columns={cols} rows={toRows(b.holdings, b.holdingsValue)} getKey={(r) => r.security_id} />
        </Card>
      ))}
    </>
  );
}
