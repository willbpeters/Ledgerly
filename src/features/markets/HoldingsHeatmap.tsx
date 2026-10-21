import { money, pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { HeatTreemap } from "./HeatTreemap";

export interface HeatHolding { ticker: string; value: number; changePct: number; }

function shareText(fraction: number): string {
  const p = fraction * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** What you hold, each tile sized by its share of your holdings and coloured by today's move. */
export function HoldingsHeatmap({ holdings }: { holdings: HeatHolding[] }) {
  const held = holdings.filter((h) => h.value > 0);
  const total = held.reduce((s, h) => s + h.value, 0);
  return (
    <Card title="Your holdings today" subtitle="Sized by share of your holdings">
      {held.length === 0 ? (
        <EmptyState title="No holdings yet" body="Your positions appear here once you hold some." />
      ) : (
        <HeatTreemap tiles={held.map((h) => ({
          key: h.ticker, label: h.ticker, size: h.value, changePct: h.changePct,
          sizeNote: shareText(h.value / total),
          title: `${h.ticker} · ${money(h.value)} · ${shareText(h.value / total)} of your holdings · ${pct(h.changePct)} today`,
        }))} />
      )}
    </Card>
  );
}
