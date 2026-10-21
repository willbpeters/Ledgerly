import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TodayBoard } from "./TodayBoard";
import { SectorHeatmap, SECTOR_WEIGHTS } from "./SectorHeatmap";
import { HoldingsHeatmap } from "./HoldingsHeatmap";
import type { IndexRow, TodayMove } from "../../domain/market";
import type { BoardGroup } from "../../domain/types";

const row = (symbol: string, label: string, group: BoardGroup, latest: number, previous: number): IndexRow => ({
  symbol, label, group, latest, recent: [previous, latest],
  changePct: ((latest - previous) / previous) * 100,
  changeBp: (latest - previous) * 100,
});

const all = (pct: number): TodayMove => ({ scope: "all", pct, pendingShare: 0, pricedLabel: "Your investments" });

const board = [
  row("^GSPC", "S&P 500", "index", 7766.93, 7712.2),
  row("^RUT", "Russell 2000", "index", 2789.45, 2805.0),
  row("^VIX", "VIX", "volatility", 16.69, 17.31),
  row("^TNX", "10-yr yield", "yield", 5.111, 5.131),
];

describe("TodayBoard", () => {
  it("shows a tile per symbol with its level", () => {
    render(<TodayBoard rows={board} you={all(0.42)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("7,766.93")).toBeInTheDocument();
    expect(screen.getByText("Russell 2000")).toBeInTheDocument();
  });

  it("colours index moves but not the VIX or yields", () => {
    render(<TodayBoard rows={board} you={all(0.42)} />);
    expect(screen.getByText("+0.7%")).toHaveClass("pos");
    expect(screen.getByText("-0.6%")).toHaveClass("neg");
    const vix = within(screen.getByRole("listitem", { name: "VIX" }));
    expect(vix.getByText("-3.6%")).not.toHaveClass("neg");
  });

  it("shows a yield as a percent level with its move in basis points", () => {
    render(<TodayBoard rows={board} you={all(0.42)} />);
    const tnx = within(screen.getByRole("listitem", { name: "10-yr yield" }));
    expect(tnx.getByText("5.11%")).toBeInTheDocument();
    expect(tnx.getByText("-2 bp")).not.toHaveClass("neg");
  });

  it("says how your investments moved today", () => {
    render(<TodayBoard rows={board} you={all(0.42)} />);
    expect(screen.getByText(/Your investments/)).toHaveTextContent("Your investments +0.4% today");
  });

  it("colours an index sparkline by its month and leaves the VIX and yields grey", () => {
    render(<TodayBoard rows={[
      { ...board[0], recent: [7000, 7400, 7766.93] },
      { ...board[1], recent: [2900, 2850, 2789.45] },
      { ...board[2], recent: [12, 20, 16.69] },
    ]} you={all(0)} />);
    const spark = (name: string) => screen.getByRole("listitem", { name }).querySelector("svg.sparkline");
    expect(spark("S&P 500")).toHaveClass("up");
    expect(spark("Russell 2000")).toHaveClass("down");
    expect(spark("VIX")).toHaveClass("flat");
  });

  it("says what has priced so far while the mutual funds wait for the close", () => {
    render(<TodayBoard rows={board} you={{ scope: "priced", pct: 0.4, pendingShare: 0.97, pricedLabel: "Your stocks" }} />);
    expect(screen.getByText(/Your stocks/)).toHaveTextContent("Your stocks +0.4% today · mutual funds (97% of your investments) price after the close");
  });

  it("says when nothing has priced yet today", () => {
    render(<TodayBoard rows={board} you={{ scope: "pending", pct: null, pendingShare: 1, pricedLabel: "" }} />);
    expect(screen.getByText(/mutual funds price after the close/)).toBeInTheDocument();
  });

  it("asks for a refresh when nothing has been fetched", () => {
    render(<TodayBoard rows={[]} you={all(0)} />);
    expect(screen.getByText("No market data yet")).toBeInTheDocument();
  });
});

describe("SectorHeatmap", () => {
  const three = [
    row("XLE", "Energy", "sector", 100.06, 100),
    row("XLK", "Technology", "sector", 101.8, 100),
    row("XLP", "Consumer staples", "sector", 99.3, 100),
  ];

  it("draws one tile per sector, coloured by its move", () => {
    render(<SectorHeatmap sectors={three} />);
    expect(screen.getByRole("listitem", { name: "Technology +1.8%" })).toHaveClass("heat-p3");
    expect(screen.getByRole("listitem", { name: "Energy +0.1%" })).toHaveClass("heat-0");
    expect(screen.getByRole("listitem", { name: "Consumer staples -0.7%" })).toHaveClass("heat-n2");
  });

  it("sizes each sector by its weight in the S&P 500, biggest first", () => {
    render(<SectorHeatmap sectors={three} />);
    const tiles = screen.getAllByRole("listitem");
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Technology +1.8%", "Consumer staples -0.7%", "Energy +0.1%",
    ]);
    // Area in percent-of-box units; the ratio of areas must match the ratio of weights.
    const area = (t: HTMLElement) => parseFloat(t.style.width) * parseFloat(t.style.height);
    const w = SECTOR_WEIGHTS;
    expect(area(tiles[0]) / area(tiles[2])).toBeCloseTo(w.XLK / w.XLE, 5);
    expect(area(tiles[1]) / area(tiles[2])).toBeCloseTo(w.XLP / w.XLE, 5);
    expect(tiles[0]).toHaveTextContent(`${w.XLK}% of S&P`);
  });

  it("still shows a sector it has no weight for, at the smallest size", () => {
    render(<SectorHeatmap sectors={[...three, row("XLNEW", "Something new", "sector", 101, 100)]} />);
    expect(screen.getByRole("listitem", { name: "Something new +1.0%" })).toBeInTheDocument();
  });

  it("knows a weight for every sector on the board, adding to about 100%", () => {
    const sum = Object.values(SECTOR_WEIGHTS).reduce((s, v) => s + v, 0);
    expect(Object.keys(SECTOR_WEIGHTS)).toHaveLength(11);
    expect(sum).toBeGreaterThan(97);
    expect(sum).toBeLessThan(103);
  });

  it("waits for the first refresh", () => {
    render(<SectorHeatmap sectors={[]} />);
    expect(screen.getByText("No sector data yet")).toBeInTheDocument();
  });
});

describe("HoldingsHeatmap", () => {
  it("draws one tile per stock, sized by value", () => {
    render(<HoldingsHeatmap holdings={[
      { ticker: "SWLGX", value: 3000, changePct: 1.2 },
      { ticker: "AAPL", value: 1000, changePct: -1.9 },
    ]} />);
    const big = screen.getByRole("listitem", { name: "SWLGX +1.2%" });
    const small = screen.getByRole("listitem", { name: "AAPL -1.9%" });
    // 3:1 by value, so 75% and 25% of the width when split side by side.
    expect(big.style.width).toBe("75%");
    expect(small.style.width).toBe("25%");
    expect(small).toHaveClass("heat-n3");
    // The tile says what share of the portfolio its size stands for.
    expect(big).toHaveTextContent("75%");
    expect(small).toHaveTextContent("25%");
  });

  it("says so when no individual stocks are held", () => {
    render(<HoldingsHeatmap holdings={[]} />);
    expect(screen.getByText("No individual stocks held")).toBeInTheDocument();
  });
});

describe("HeatTreemap", () => {
  it("keeps text off tiles too small to read, but still names them", () => {
    render(<HoldingsHeatmap holdings={[
      { ticker: "BIG", value: 980, changePct: 0.5 },
      { ticker: "TINY", value: 20, changePct: -0.5 },
    ]} />);
    const tiny = screen.getByRole("listitem", { name: "TINY -0.5%" });
    expect(tiny).toHaveClass("heat-tiny");
    expect(tiny).toHaveAttribute("title", expect.stringContaining("TINY"));
    expect(screen.getByRole("listitem", { name: "BIG +0.5%" })).not.toHaveClass("heat-tiny");
  });
});
