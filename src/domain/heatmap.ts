/**
 * Pure helpers for the Markets heatmaps and sparklines: how hot a move is, how
 * to tile a set of values into a box, and how to draw a few closes as a line.
 */

/**
 * A day's move as one of seven colour steps, -3 (deep red) to 3 (deep green).
 * Moves under 0.1% read as flat. Beyond `cap` percent the colour saturates, so
 * one wild day does not wash every other tile out to the same pale shade.
 */
export function heatLevel(pct: number, cap = 2): number {
  const size = Math.abs(pct);
  if (size < 0.1) return 0;
  const step = Math.min(3, Math.ceil((size / cap) * 3));
  return pct > 0 ? step : -step;
}

export interface TreemapItem { key: string; value: number; }
export interface TreemapRect { key: string; x: number; y: number; w: number; h: number; }

/**
 * Tile items into a `width` × `height` box with areas proportional to value.
 * A binary split: the items, largest first, are cut into two groups of roughly
 * equal value, the box is cut along its longer side in the same proportion,
 * and each half recurses. Not the squarest layout possible, but every tile is
 * exact in area, nothing overlaps, and for a dozen holdings it reads well.
 */
export function treemap(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const out: TreemapRect[] = [];
  layout(sorted, 0, 0, width, height, out);
  return out;
}

function layout(items: TreemapItem[], x: number, y: number, w: number, h: number, out: TreemapRect[]) {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ key: items[0].key, x, y, w, h });
    return;
  }
  const total = items.reduce((s, i) => s + i.value, 0);
  // The cut that brings the first group closest to half the value.
  let acc = 0;
  let cut = 1;
  let best = Infinity;
  for (let k = 0; k < items.length - 1; k++) {
    acc += items[k].value;
    const miss = Math.abs(acc - total / 2);
    if (miss < best) { best = miss; cut = k + 1; }
  }
  const first = items.slice(0, cut);
  const share = first.reduce((s, i) => s + i.value, 0) / total;
  if (w >= h) {
    layout(first, x, y, w * share, h, out);
    layout(items.slice(cut), x + w * share, y, w * (1 - share), h, out);
  } else {
    layout(first, x, y, w, h * share, out);
    layout(items.slice(cut), x, y + h * share, w, h * (1 - share), out);
  }
}

/** An SVG path for a sparkline in a `width` × `height` box, high values at the top. */
export function sparkPath(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = width / (values.length - 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  return values
    .map((v, i) => {
      const y = max === min ? height / 2 : height - ((v - min) / (max - min)) * height;
      return `${i === 0 ? "M" : "L"}${round(i * step)} ${round(y)}`;
    })
    .join(" ");
}
