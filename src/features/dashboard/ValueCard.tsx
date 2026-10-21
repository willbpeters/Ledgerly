import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { localIsoDate } from "../../domain/dates";
import { HISTORY_DAYS } from "../../data/useValueSeries";
import { money, pct, fmtDate } from "../../ui/format";
import { Card, EmptyState, Segmented } from "../../ui/components";
import { useChartColors } from "../../ui/chartColors";
import type { PortfolioSummary, ValuePoint } from "../../domain/types";

// Only windows the data can actually support: the series is rebuilt from
// SimpleFIN holdings and transactions, which reach back about 90 days.
type Range = "1m" | "3m";
const WINDOW_DAYS: Record<Range, number> = { "1m": 30, "3m": HISTORY_DAYS };

/** Which line the value chart plots, and which tab is selected. */
export type Mode = "networth" | "invested" | "cash" | "liabilities";
export const MODE_ORDER: Mode[] = ["networth", "invested", "cash", "liabilities"];

const SHARE_CAVEAT = "Share counts are today’s — SimpleFIN does not report holdings history.";

// The caveat has to change with the mode. The net-worth line really is rebuilt
// from cash movements, so it must say so; the investments line is not, and
// repeating the clause there would be untrue. The share-count caveat applies to
// the two lines that contain holdings — today's synced share counts are assumed
// to have been held throughout, which is what bounds the window to 90 days.
export const CHART_MODES: Record<Mode, { label: string; dataKey: keyof ValuePoint; subtitle: string }> = {
  networth: {
    label: "Net worth", dataKey: "value",
    subtitle: `Rebuilt from your holdings, prices and cash movements. ${SHARE_CAVEAT}`,
  },
  invested: {
    label: "Investments", dataKey: "invested",
    subtitle: `Your holdings’ market value, rebuilt from daily closes. A deposit does not move this line. ${SHARE_CAVEAT}`,
  },
  cash: {
    label: "Cash", dataKey: "cash",
    subtitle: "Your cash balances, walked back from today through the transactions posted since. Brokerage cash is included.",
  },
  liabilities: {
    label: "Liabilities", dataKey: "liabilities",
    subtitle: "What you owe on credit accounts, walked back from today’s balance through the transactions posted since.",
  },
};

/**
 * The Y axis floor. Zoomed to the data rather than anchored at zero, or a
 * portfolio that has never been near zero wastes most of the chart — but cash
 * can be overdrawn, so a negative minimum must stay on screen too.
 */
export function yAxisMin(min: number): number {
  return min >= 0 ? min * 0.97 : min * 1.03;
}

/** Today's figure for a tab. Liabilities stay negative here, as they enter net worth. */
function figure(mode: Mode, s: PortfolioSummary): number {
  switch (mode) {
    case "networth": return s.totalValue;
    case "invested": return s.investedValue;
    case "cash": return s.cash;
    case "liabilities": return s.liabilities;
  }
}

function clipSeries(series: ValuePoint[], range: Range): ValuePoint[] {
  const days = WINDOW_DAYS[range];
  if (series.length === 0) return series;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const iso = localIsoDate(cutoff);
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

const signed = (n: number, text: string) => `${n > 0 ? "+" : ""}${text}`;

/**
 * The Dashboard's main card. Its tabs are the headline: each carries today's
 * figure for one measure and picks the line the chart plots. Investments +
 * Cash + Liabilities = Net worth, so the row is checkable by eye. Today and All
 * time sit under Investments because that is all they measure — a deposit
 * changes net worth and must never move them.
 */
export function ValueCard({ summary, series: fullSeries }: { summary: PortfolioSummary; series: ValuePoint[] }) {
  const colors = useChartColors();
  const [range, setRange] = useState<Range>("3m");
  // Net worth is the default, so the screen opens as it always has.
  const [mode, setMode] = useState<Mode>("networth");
  const series = useMemo(() => clipSeries(fullSeries, range), [fullSeries, range]);
  const [dollars, cents] = money(summary.totalValue).split(".");

  return (
    <Card>
      <div className="value-tabs" role="tablist">
        {MODE_ORDER.map((m) => {
          const fig = figure(m, summary);
          return (
            <button key={m} role="tab" aria-label={CHART_MODES[m].label} aria-selected={m === mode}
              onClick={() => setMode(m)}>
              <span className="cap">{CHART_MODES[m].label}</span>
              {m === "networth" ? (
                <span className="hero-value">{dollars}<span className="hero-cents">.{cents}</span></span>
              ) : (
                <span className={`n value-tab-figure${fig < 0 ? " neg" : ""}`}>{money(fig)}</span>
              )}
              {m === "invested" && (
                <span className="value-tab-sub">
                  <span className={summary.dayChange >= 0 ? "pos" : "neg"}>{signed(summary.dayChange, money(summary.dayChange))} today</span>
                  {" · "}
                  <span className={summary.unrealized >= 0 ? "pos" : "neg"}>{pct(summary.unrealizedPct)} all time</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="row between center" style={{ marginBottom: 6 }}>
        <div className="card-subtitle">{CHART_MODES[mode].subtitle}</div>
        <Segmented<Range> value={range} onChange={setRange} items={[
          { value: "1m", label: "1M" }, { value: "3m", label: "3M" },
        ]} />
      </div>

      {series.length < 2 ? (
        <EmptyState title="Not enough price history yet"
          body="The chart is rebuilt from daily closes. Ledgerly downloads them on first launch — if you have just connected an account, give it a moment and refresh." />
      ) : (
        <ResponsiveContainer width="100%" height={380}>
          <AreaChart data={series} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.accent} stopOpacity={0.16} />
                <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis dataKey="date" fontSize={10} stroke={colors.text} tickLine={false} axisLine={false} tickFormatter={fmtDate} minTickGap={40} />
            <YAxis fontSize={10} stroke={colors.text} tickLine={false} axisLine={false} width={58}
              domain={[yAxisMin, (max: number) => max * 1.02]}
              // Below a thousand dollars, dividing by 1000 rounds every tick to $0k —
              // and the investments and liabilities lines are the likeliest to be that small.
              tickFormatter={(v) => {
                const n = Number(v);
                const sign = n < 0 ? "-" : "";
                return Math.abs(n) < 1000 ? `${sign}$${Math.round(Math.abs(n))}` : `${sign}$${Math.round(Math.abs(n) / 1000)}k`;
              }} />
            <Tooltip content={<ChartTip />} cursor={{ stroke: colors.grid, strokeDasharray: "3 4" }} />
            <Area type="monotone" dataKey={CHART_MODES[mode].dataKey} stroke={colors.accent} strokeWidth={1.9} fill="url(#valueFill)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
