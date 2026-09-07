import { useState } from "react";
import { usePortfolio } from "../../data/usePortfolio";
import { money, pct } from "../../ui/format";
import type { Holding } from "../../domain/types";

// Toggleable columns (Ticker is always shown). `weight` is passed in per table
// so the same column can mean "% of all holdings" or "% of this account".
interface Col {
  key: string;
  label: string;
  render: (h: Holding, weight: number | null) => React.ReactNode;
  cls?: (h: Holding) => string;
}

const COLS: Col[] = [
  { key: "shares", label: "Shares", render: (h) => h.shares },
  { key: "avgCost", label: "Avg cost", render: (h) => money(h.avgCost) },
  { key: "lastPrice", label: "Last", render: (h) => (h.lastPrice ? money(h.lastPrice) : "—") },
  { key: "marketValue", label: "Market value", render: (h) => money(h.marketValue) },
  { key: "unrealized", label: "Unrealized", render: (h) => money(h.unrealized), cls: (h) => (h.unrealized >= 0 ? "pos" : "neg") },
  { key: "returnPct", label: "Return %", render: (h) => pct(h.unrealizedPct), cls: (h) => (h.unrealizedPct >= 0 ? "pos" : "neg") },
  { key: "weight", label: "% of holdings", render: (_h, w) => (w == null ? "—" : w.toFixed(1) + "%") },
];

const STORAGE_KEY = "ledgerly.holdings.cols";
const DEFAULT_VISIBLE = COLS.map((c) => c.key);

function loadVisible(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const known = parsed.filter((k) => COLS.some((c) => c.key === k));
      if (known.length) return known;
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE;
}

function HoldingsTable({ holdings, visible, denom }: { holdings: Holding[]; visible: string[]; denom: number }) {
  if (holdings.length === 0) return <p style={{ color: "var(--mut)" }}>No holdings.</p>;
  const cols = COLS.filter((c) => visible.includes(c.key));
  return (
    <table>
      <thead><tr><th>Ticker</th>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>
        {holdings.map((h) => {
          const weight = denom > 0 ? (h.marketValue / denom) * 100 : null;
          return (
            <tr key={h.security_id}>
              <td>{h.ticker}</td>
              {cols.map((c) => (
                <td key={c.key} className={c.cls ? c.cls(h) : undefined}>{c.render(h, weight)}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Holdings() {
  const { holdings, summary, byAccount, isLoading } = usePortfolio();
  const [visible, setVisible] = useState<string[]>(loadVisible);
  const [showCols, setShowCols] = useState(false);

  if (isLoading) return <p>Loading…</p>;

  function toggle(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // accounts that actually hold something, for the per-account breakdown
  const accountsWithHoldings = byAccount.filter((b) => b.holdings.length > 0);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Holdings</h1>
        <div style={{ position: "relative" }}>
          <button className="secondary" onClick={() => setShowCols((s) => !s)} title="Choose columns">⚙ Columns</button>
          {showCols && (
            <div className="card" style={{ position: "absolute", right: 0, top: "110%", zIndex: 10, minWidth: 180 }}>
              {COLS.map((c) => (
                <label key={c.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <input type="checkbox" checked={visible.includes(c.key)} onChange={() => toggle(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 8 }}>All accounts</div>
        {holdings.length === 0
          ? <p>No holdings yet. Add a position in Activity.</p>
          : <HoldingsTable holdings={holdings} visible={visible} denom={summary.investedValue} />}
      </div>

      {accountsWithHoldings.length > 1 && (
        <>
          <div style={{ fontSize: 12, color: "var(--mut)", textTransform: "uppercase", letterSpacing: ".5px" }}>
            By account
          </div>
          {accountsWithHoldings.map((b) => (
            <div className="card" key={b.account.id}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <strong>{b.account.name}</strong>
                <span style={{ color: "var(--mut)" }}>
                  {money(b.holdingsValue)} in holdings{b.cash ? ` · ${money(b.cash)} cash` : ""}
                </span>
              </div>
              <HoldingsTable holdings={b.holdings} visible={visible} denom={b.holdingsValue} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
