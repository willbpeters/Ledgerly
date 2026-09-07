import { PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { usePortfolio } from "../../data/usePortfolio";
import { useSnapshots } from "../../data/queries";
import { toValueSeries } from "../../domain/series";
import { money, pct } from "../../ui/format";

const COLORS = ["#4f46e5", "#16a34a", "#f59e0b", "#db2777", "#0891b2", "#7c3aed"];

export function Dashboard() {
  const { summary, allocationType, isLoading } = usePortfolio();
  const { data: snapshots = [] } = useSnapshots();
  const series = toValueSeries(snapshots);
  if (isLoading) return <p>Loading…</p>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Dashboard</h1>
      <div>
        <div style={{ color: "var(--mut)", fontSize: 12 }}>Total portfolio</div>
        <div style={{ fontSize: 32, fontWeight: 800 }}>{money(summary.totalValue)}</div>
        <div className={summary.dayChange >= 0 ? "pos" : "neg"}>
          {money(summary.dayChange)} today ({pct(summary.dayChangePct)})
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <Kpi label="Total gain" value={money(summary.unrealized)} tone={summary.unrealized} />
        <Kpi label="Return" value={pct(summary.unrealizedPct)} tone={summary.unrealizedPct} />
        <Kpi label="Realized" value={money(summary.realized)} tone={summary.realized} />
        <Kpi label="Cash" value={money(summary.cash)} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 8 }}>Value over time</div>
          {series.length < 2 ? <p style={{ color: "var(--mut)" }}>Chart builds as daily snapshots accumulate.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={series}>
                <XAxis dataKey="date" fontSize={11} /><YAxis fontSize={11} width={70} />
                <Tooltip formatter={(v) => money(Number(v))} />
                <Line type="monotone" dataKey="value" stroke="#4f46e5" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 8 }}>Allocation</div>
          {allocationType.length === 0 ? <p style={{ color: "var(--mut)" }}>No holdings yet.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={allocationType} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80}>
                  {allocationType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => money(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone == null ? "" : tone >= 0 ? "pos" : "neg";
  return (
    <div className="card">
      <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--mut)" }}>{label}</div>
      <div className={cls} style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
