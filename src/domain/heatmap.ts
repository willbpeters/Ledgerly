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
 *
 * Squarified (Bruls, Huizing and van Wijk): items, largest first, are laid in
 * strips along the box's shorter side, and a strip takes another item only
 * while that makes its worst tile squarer. Tiles stay close to square, which is
 * what lets a label fit — an earlier halving layout cut thin slivers whose text
 * overlapped. Every tile is exact in area and nothing overlaps.
 */
export function treemap(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = sorted.map((i) => ({ key: i.key, area: i.value * scale }));

  const out: TreemapRect[] = [];
  let [x, y, w, h] = [0, 0, width, height];
  let k = 0;
  while (k < areas.length) {
    const side = Math.min(w, h);
    const row = [areas[k++]];
    while (k < areas.length && worst([...row, areas[k]], side) <= worst(row, side)) row.push(areas[k++]);

    const rowArea = row.reduce((s, r) => s + r.area, 0);
    // The last strip takes all the space left, so float drift never leaves a gap.
    const thickness = k === areas.length ? (w >= h ? w : h) : rowArea / side;
    let offset = 0;
    for (const r of row) {
      const length = (r.area / rowArea) * side;
      if (w >= h) out.push({ key: r.key, x, y: y + offset, w: thickness, h: length });
      else out.push({ key: r.key, x: x + offset, y, w: length, h: thickness });
      offset += length;
    }
    if (w >= h) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
  }
  return out;
}

/** The worst aspect ratio in a strip of `row` laid along a side of length `side`. */
function worst(row: { area: number }[], side: number): number {
  const sum = row.reduce((s, r) => s + r.area, 0);
  const s2 = side * side;
  let w = 0;
  for (const r of row) w = Math.max(w, (s2 * r.area) / (sum * sum), (sum * sum) / (s2 * r.area));
  return w;
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

/** The sparkline's line closed down to the bottom edge, for a soft fill beneath it. */
export function sparkArea(values: number[], width: number, height: number): string {
  const line = sparkPath(values, width, height);
  return line ? `${line} L${width} ${height} L0 ${height} Z` : "";
}

/** Which way a run of closes went, first to last. */
export function trend(values: number[]): "up" | "down" | "flat" {
  if (values.length < 2) return "flat";
  const [first, last] = [values[0], values[values.length - 1]];
  return last > first ? "up" : last < first ? "down" : "flat";
}
