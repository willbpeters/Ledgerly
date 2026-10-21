import { money, pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { HeatTreemap } from "./HeatTreemap";

export interface HeatHolding { ticker: string; value: number; changePct: number; }

function shareText(fraction: number): string {
  const p = fraction * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/**
 * The individual stocks you hold, each tile sized by its share of them and
 * coloured by today's move. Funds are left out on purpose: they are most of the
 * portfolio, mutual funds price once a day so they sit at 0% until the close,
 * and a few big grey tiles would crowd out the stocks that actually moved.
 */
export function HoldingsHeatmap({ holdings }: { holdings: HeatHolding[] }) {
  const held = holdings.filter((h) => h.value > 0);
  const total = held.reduce((s, h) => s + h.value, 0);
  return (
    <Card title="Your stocks today" subtitle="Sized by share of your individual stocks">
      {held.length === 0 ? (
        <EmptyState title="No individual stocks held" body="Stocks appear here once you hold some; funds are left out." />
      ) : (
        <HeatTreemap tiles={held.map((h) => ({
          key: h.ticker, label: h.ticker, size: h.value, changePct: h.changePct,
          sizeNote: shareText(h.value / total),
          title: `${h.ticker} · ${money(h.value)} · ${shareText(h.value / total)} of your stocks · ${pct(h.changePct)} today`,
        }))} />
      )}
    </Card>
  );
}
