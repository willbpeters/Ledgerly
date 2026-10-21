import { pct } from "../../ui/format";
import { heatLevel, treemap } from "../../domain/heatmap";

/** `heat-p3` … `heat-0` … `heat-n3`, the classes styles.css colours. */
export function heatClass(changePct: number): string {
  const l = heatLevel(changePct);
  return l === 0 ? "heat-0" : l > 0 ? `heat-p${l}` : `heat-n${-l}`;
}

export interface HeatTile {
  key: string;
  label: string;
  /** What sets the tile's area. */
  size: number;
  changePct: number;
  /** A short line saying what the size stands for, e.g. "33% of S&P". */
  sizeNote: string;
  /** Hover text. */
  title: string;
}

// The tiling box's proportions. Tiles are placed in percent of it, so the card
// can be any width; this only decides which way the first cuts run.
const BOX_W = 200;
const BOX_H = 100;
// Below these fractions of the box's width or height, a tile drops its text.
const TINY_W = 0.1;
const TINY_H = 0.22;

/** Tiles whose area is proportional to `size`, coloured by today's move. */
export function HeatTreemap({ tiles }: { tiles: HeatTile[] }) {
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const rects = treemap(tiles.map((t) => ({ key: t.key, value: t.size })), BOX_W, BOX_H);
  return (
    <ul className="heat-treemap">
      {rects.map((r) => {
        const t = byKey.get(r.key)!;
        // Too small to hold readable text: the colour still shows, and the
        // name and figures live in the hover text and the accessible name.
        const tiny = r.w / BOX_W < TINY_W || r.h / BOX_H < TINY_H;
        return (
          <li key={r.key} className={`heat-tile ${heatClass(t.changePct)}${tiny ? " heat-tiny" : ""}`}
            aria-label={`${t.label} ${pct(t.changePct)}`}
            title={t.title}
            style={{
              left: `${(r.x / BOX_W) * 100}%`, top: `${(r.y / BOX_H) * 100}%`,
              width: `${(r.w / BOX_W) * 100}%`, height: `${(r.h / BOX_H) * 100}%`,
            }}>
            <span className="heat-name">{t.label}</span>
            <span className="heat-move n">{pct(t.changePct)}</span>
            <span className="heat-size">{t.sizeNote}</span>
          </li>
        );
      })}
    </ul>
  );
}
