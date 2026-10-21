import { pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { heatLevel } from "../../domain/heatmap";
import type { IndexRow } from "../../domain/market";

/** `heat-p3` … `heat-0` … `heat-n3`, the classes styles.css colours. */
export function heatClass(changePct: number): string {
  const l = heatLevel(changePct);
  return l === 0 ? "heat-0" : l > 0 ? `heat-p${l}` : `heat-n${-l}`;
}

/** The eleven S&P sectors, one equal tile each, coloured by today's move. */
export function SectorHeatmap({ sectors }: { sectors: IndexRow[] }) {
  return (
    <Card title="S&P sectors today" subtitle="Sector funds, biggest gain first">
      {sectors.length === 0 ? (
        <EmptyState title="No sector data yet" body="Press Refresh to fetch today's moves." />
      ) : (
        <ul className="sector-heat">
          {sectors.map((s) => (
            <li key={s.symbol} className={`heat-tile ${heatClass(s.changePct)}`} aria-label={`${s.label} ${pct(s.changePct)}`}
              title={`${s.label} (${s.symbol})`}>
              <span className="heat-name">{s.label}</span>
              <span className="heat-move n">{pct(s.changePct)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
