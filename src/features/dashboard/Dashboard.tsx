import { PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { usePortfolio } from "../../data/usePortfolio";
import { useSnapshots } from "../../data/queries";
import { toValueSeries } from "../../domain/series";
import { money, pct } from "../../ui/format";
import { PageHeader, Card, StatCard, EmptyState } from "../../ui/components";
import { useChartColors } from "../../ui/chartColors";
import type { AllocationSlice } from "../../domain/types";

function ChartTip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip"><div className="muted">{label}</div><strong>{money(payload[0].value)}</strong></div>;
}

function Donut({ data, colors }: { data: AllocationSlice[]; colors: string[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 16, alignItems: "center" }}>
      <ResponsiveContainer width="100%" height={150}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={48} outerRadius={70} stroke="none" paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          <Tooltip content={<ChartTip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="legend">
        {data.map((s, i) => (
          <div className="legend-row" key={s.label}>
            <span className="legend-swatch" style={{ background: colors[i % colors.length] }} />
            <span>{s.label}</span>
            <span className="num">{money(s.value)}</span>
            <span className="pct num">{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  const { summary, allocationType, allocationAccount, isLoading } = usePortfolio();
  const { data: snapshots = [] } = useSnapshots();
  const colors = useChartColors();
  const series = toValueSeries(snapshots);
  if (isLoading) return <p className="muted">Loading…</p>;

  const dayTone = summary.dayChange > 0 ? "pos" : summary.dayChange < 0 ? "neg" : "neutral";

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your whole portfolio at a glance" />
      <div className="hero">
        <div className="hero-label">Total portfolio value</div>
        <div className="hero-value">{money(summary.totalValue)}</div>
        <span className={`chip ${dayTone}`}>{money(summary.dayChange)} today · {pct(summary.dayChangePct)}</span>
      </div>

      <div className="grid grid-4">
        <StatCard label="Total gain" value={money(summary.unrealized)} delta={summary.unrealized} hint={`on ${money(summary.totalCostBasis)} invested`} />
        <StatCard label="Return" value={pct(summary.unrealizedPct)} delta={summary.unrealizedPct} />
        <StatCard label="Realized" value={money(summary.realized)} delta={summary.realized} />
        <StatCard label="Cash" value={money(summary.cash)} hint={`${money(summary.investedValue)} in holdings`} />
      </div>

      <div className="grid grid-main">
        <Card title="Value over time">
          {series.length < 2 ? (
            <EmptyState title="Chart is warming up" body="It builds from daily snapshots. Come back tomorrow." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={series} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.accent} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="date" fontSize={11} stroke={colors.text} tickLine={false} axisLine={false} />
                <YAxis fontSize={11} stroke={colors.text} tickLine={false} axisLine={false} width={64}
                  tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="value" stroke={colors.accent} strokeWidth={2} fill="url(#valueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Allocation by type">
          {allocationType.length === 0 ? <EmptyState title="No holdings yet" body="Add a position in Activity." />
            : <Donut data={allocationType} colors={colors.series} />}
        </Card>
      </div>

      <Card title="Allocation by account">
        {allocationAccount.length === 0 ? <EmptyState title="No accounts with value yet" />
          : <Donut data={allocationAccount} colors={colors.series} />}
      </Card>
    </>
  );
}
