import { pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { HeatTreemap } from "./HeatTreemap";
import type { IndexRow } from "../../domain/market";

/**
 * Each sector's approximate share of the S&P 500, in percent, by its SPDR fund.
 *
 * A static table because the free price feed carries no index weights. Sector
 * weights drift slowly — a point or two a year, more for tech in a strong run —
 * so this sizes tiles truthfully enough, but it wants a refresh now and then
 * from S&P's published sector breakdown. As of October 2026.
 */
export const SECTOR_WEIGHTS: Record<string, number> = {
  XLK: 33,
  XLF: 13,
  XLY: 10.5,
  XLC: 9.5,
  XLV: 9.5,
  XLI: 8.5,
  XLP: 5.5,
  XLE: 3,
  XLU: 2.5,
  XLRE: 2,
  XLB: 2,
};

// A sector missing from the table still appears, at the smallest known size,
// rather than vanishing from a heatmap that claims to show them all.
const FALLBACK_WEIGHT = Math.min(...Object.values(SECTOR_WEIGHTS));

/** The eleven S&P sectors, each sized by its weight in the index and coloured by today's move. */
export function SectorHeatmap({ sectors }: { sectors: IndexRow[] }) {
  return (
    <Card title="S&P sectors today" subtitle="Sized by approximate weight in the S&P 500">
      {sectors.length === 0 ? (
        <EmptyState title="No sector data yet" body="Press Refresh to fetch today's moves." />
      ) : (
        <HeatTreemap tiles={sectors.map((s) => {
          const weight = SECTOR_WEIGHTS[s.symbol] ?? FALLBACK_WEIGHT;
          return {
            key: s.symbol, label: s.label, size: weight, changePct: s.changePct,
            sizeNote: `${weight}% of S&P`,
            title: `${s.label} (${s.symbol}) · about ${weight}% of the S&P 500 · ${pct(s.changePct)} today`,
          };
        })} />
      )}
    </Card>
  );
}
