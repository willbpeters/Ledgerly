import { money, pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { treemap } from "../../domain/heatmap";
import { heatClass } from "./SectorHeatmap";

export interface HeatHolding { ticker: string; value: number; changePct: number; }

// The tiling box's proportions. Tiles are placed in percent of it, so the card
// can be any width; this only decides which way the first cuts run.
const BOX_W = 200;
const BOX_H = 100;

/** What you hold, each tile sized by its value and coloured by today's move. */
export function HoldingsHeatmap({ holdings }: { holdings: HeatHolding[] }) {
  const byTicker = new Map(holdings.map((h) => [h.ticker, h]));
  const rects = treemap(holdings.map((h) => ({ key: h.ticker, value: h.value })), BOX_W, BOX_H);
  return (
    <Card title="Your holdings today" subtitle="Sized by value">
      {rects.length === 0 ? (
        <EmptyState title="No holdings yet" body="Your positions appear here once you hold some." />
      ) : (
        <ul className="holdings-heat">
          {rects.map((r) => {
            const h = byTicker.get(r.key)!;
            return (
              <li key={r.key} className={`heat-tile ${heatClass(h.changePct)}`} aria-label={`${h.ticker} ${pct(h.changePct)}`}
                title={`${h.ticker} · ${money(h.value)} · ${pct(h.changePct)}`}
                style={{
                  left: `${(r.x / BOX_W) * 100}%`, top: `${(r.y / BOX_H) * 100}%`,
                  width: `${(r.w / BOX_W) * 100}%`, height: `${(r.h / BOX_H) * 100}%`,
                }}>
                <span className="heat-name">{h.ticker}</span>
                <span className="heat-move n">{pct(h.changePct)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
