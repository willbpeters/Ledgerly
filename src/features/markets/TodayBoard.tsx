import type { ReactNode } from "react";
import { pct } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import { Sparkline } from "../../ui/Sparkline";
import { trend } from "../../domain/heatmap";
import type { IndexRow } from "../../domain/market";

function level(r: IndexRow): string {
  if (r.group === "yield") return `${r.latest.toFixed(2)}%`;
  return r.latest.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The move, as each group should read. Indices are coloured: up is good news
 * for someone who owns them. The VIX and yields are not — a rising VIX or a
 * rising yield is neither, and green or red would say otherwise.
 */
function Change({ r }: { r: IndexRow }) {
  if (r.group === "yield") {
    const bp = Math.round(r.changeBp);
    return <span className="board-change">{`${bp > 0 ? "+" : ""}${bp} bp`}</span>;
  }
  if (r.group === "volatility") return <span className="board-change">{pct(r.changePct)}</span>;
  const tone = r.changePct > 0 ? "pos" : r.changePct < 0 ? "neg" : "";
  return <span className={`board-change ${tone}`.trim()}>{pct(r.changePct)}</span>;
}

/** The Markets screen's full-width Today card: the major indices, the VIX and yields. */
export function TodayBoard({ rows, you, actions, footer }:
  { rows: IndexRow[]; you: number; actions?: ReactNode; footer?: ReactNode }) {
  const youTone = you > 0 ? "pos" : you < 0 ? "neg" : "";
  return (
    <Card title="Today" actions={
      <div className="row center" style={{ gap: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Your investments <span className={youTone}>{pct(you)}</span> today
        </span>
        {actions}
      </div>
    }>
      {rows.length === 0 ? (
        <EmptyState title="No market data yet" body="Press Refresh to fetch today's levels." />
      ) : (
        <ul className="board">
          {rows.map((r) => (
            <li key={r.symbol} className="board-tile" aria-label={r.label}>
              <div className="board-head">
                <div>
                  <div className="cell-secondary">{r.label}</div>
                  <div className="board-level n">{level(r)}</div>
                </div>
                <Change r={r} />
              </div>
              {/* Coloured by the month's direction for what you would own;
                  the VIX and yields stay grey for the same reason their moves do. */}
              <Sparkline values={r.recent}
                tone={r.group === "index" || r.group === "sector" ? trend(r.recent) : "flat"} />
            </li>
          ))}
        </ul>
      )}
      {footer}
    </Card>
  );
}
