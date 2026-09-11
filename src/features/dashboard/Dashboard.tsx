import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { usePortfolio } from "../../data/usePortfolio";
import { useSecurities } from "../../data/queries";
import { useValueSeries, HISTORY_DAYS } from "../../data/useValueSeries";
import { money, pct, fmtDate } from "../../ui/format";
import { Card, EmptyState, Segmented } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import { useChartColors } from "../../ui/chartColors";
import { RiskCard } from "./RiskCard";
import type { Holding, SeriesPoint } from "../../domain/types";

// Only windows the data can actually support: the series is rebuilt from
// SimpleFIN holdings and transactions, which reach back about 90 days.
type Range = "1m" | "3m";
const WINDOW_DAYS: Record<Range, number> = { "1m": 30, "3m": HISTORY_DAYS };

function clipSeries(series: SeriesPoint[], range: Range): SeriesPoint[] {
  const days = WINDOW_DAYS[range];
  if (series.length === 0) return series;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const iso = cutoff.toISOString().slice(0, 10);
  const clipped = series.filter((p) => p.date >= iso);
  // Never show an empty chart just because the window is narrower than the data.
  return clipped.length >= 2 ? clipped : series;
}

function ChartTip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="muted">{fmtDate(String(label))}</div>
      <strong className="n">{money(payload[0].value)}</strong>
    </div>
  );
}

interface Row extends Holding { weight: number | null; name: string | null; colour: string }

export function Dashboard() {
  const { holdings, summary, isLoading } = usePortfolio();
  const { series: fullSeries } = useValueSeries();
  const { data: securities = [] } = useSecurities();
  const colors = useChartColors();
  const [range, setRange] = useState<Range>("3m");

  const series = useMemo(() => clipSeries(fullSeries, range), [fullSeries, range]);

  if (isLoading) return <p className="muted">Loading…</p>;

  const nameOf = new Map(securities.map((s) => [s.id, s.name]));
  const rows: Row[] = holdings.map((h, i) => ({
    ...h,
    name: nameOf.get(h.security_id) ?? null,
    weight: summary.investedValue > 0 ? (h.marketValue / summary.investedValue) * 100 : null,
    colour: colors.series[i % colors.series.length],
  }));

  const columns: Column<Row>[] = [
    {
      key: "ticker", label: "Ticker", align: "left",
      render: (r) => (
        <span className="ticker-cell">
          <span className="ticker-mark" style={{ background: r.colour }} />
          <span>
            <span className="cell-primary" style={{ display: "block" }}>{r.ticker}</span>
            {r.name && <span className="cell-secondary">{r.name}</span>}
          </span>
        </span>
      ),
    },
    { key: "shares", label: "Shares", render: (r) => r.shares },
    { key: "last", label: "Last", render: (r) => (r.lastPrice ? money(r.lastPrice) : "—") },
    { key: "value", label: "Value", render: (r) => <span className="cell-primary">{money(r.marketValue)}</span> },
    {
      key: "gain", label: "Gain",
      render: (r) => `${r.unrealized >= 0 ? "+" : ""}${money(r.unrealized)} · ${pct(r.unrealizedPct)}`,
      className: (r) => (r.unrealized >= 0 ? "pos" : "neg"),
    },
    {
      key: "weight", label: "Weight",
      render: (r) => r.weight == null ? "—" : (
        <span className="bar">
          <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, r.weight)}%`, background: r.colour }} /></span>
          {r.weight.toFixed(0)}%
        </span>
      ),
    },
  ];

  const [dollars, cents] = money(summary.totalValue).split(".");

  return (
    <>
      <div className="headline">
        <div className="headline-figure">
          <div className="cap">Net worth</div>
          <div className="hero-value">{dollars}<span className="hero-cents">.{cents}</span></div>
        </div>
        <div className="headline-side">
          <div className="cap">Today</div>
          <div className={`n ${summary.dayChange >= 0 ? "pos" : "neg"}`}>
            {summary.dayChange >= 0 ? "+" : ""}{money(summary.dayChange)} · {pct(summary.dayChangePct)}
          </div>
        </div>
        <div className="headline-side">
          <div className="cap">All time</div>
          <div className={`n ${summary.unrealized >= 0 ? "pos" : "neg"}`}>
            {summary.unrealized >= 0 ? "+" : ""}{money(summary.unrealized)} · {pct(summary.unrealizedPct)}
          </div>
        </div>
        <div className="headline-side">
          <div className="cap">Cash</div>
          <div className="n">{money(summary.cash)}</div>
        </div>
        {summary.liabilities !== 0 && (
          <div className="headline-side">
            <div className="cap">Owed</div>
            <div className="n neg">{money(summary.liabilities)}</div>
          </div>
        )}
      </div>

      <Card
        title="Portfolio value"
        subtitle="Rebuilt from your holdings, prices and cash movements. Share counts are today’s — SimpleFIN does not report holdings history."
        actions={
          <Segmented<Range> value={range} onChange={setRange} items={[
            { value: "1m", label: "1M" }, { value: "3m", label: "3M" },
          ]} />
        }>
        {series.length < 2 ? (
          <EmptyState title="Not enough price history yet"
            body="The chart is rebuilt from daily closes. Ledgerly downloads them on first launch — if you have just connected an account, give it a moment and refresh." />
        ) : (
          <ResponsiveContainer width="100%" height={236}>
            <AreaChart data={series} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors.accent} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              <XAxis dataKey="date" fontSize={10} stroke={colors.text} tickLine={false} axisLine={false} tickFormatter={fmtDate} minTickGap={40} />
              {/* Zoom to the data rather than anchoring at zero, or a portfolio
                  that has never been near zero wastes most of the chart. */}
              <YAxis fontSize={10} stroke={colors.text} tickLine={false} axisLine={false} width={58}
                domain={[(min: number) => Math.max(0, min * 0.97), (max: number) => max * 1.02]}
                tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
              <Tooltip content={<ChartTip />} cursor={{ stroke: colors.grid, strokeDasharray: "3 4" }} />
              <Area type="monotone" dataKey="value" stroke={colors.accent} strokeWidth={1.9} fill="url(#valueFill)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <RiskCard holdings={holdings} cash={summary.cash} />

      <Card title="Positions" actions={<Link to="/holdings" style={{ fontSize: 11, fontWeight: 600 }}>View all</Link>}>
        {rows.length === 0 ? (
          <EmptyState title="No holdings yet"
            body={<>Add a position in <Link to="/activity">Activity</Link>, or connect SimpleFIN in <Link to="/settings">Settings</Link>.</>} />
        ) : (
          <DataTable columns={columns} rows={rows} getKey={(r) => r.security_id} />
        )}
      </Card>
    </>
  );
}
