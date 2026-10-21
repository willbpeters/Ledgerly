import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TodayBoard } from "./TodayBoard";
import { SectorHeatmap } from "./SectorHeatmap";
import { HoldingsHeatmap } from "./HoldingsHeatmap";
import type { IndexRow } from "../../domain/market";
import type { BoardGroup } from "../../domain/types";

const row = (symbol: string, label: string, group: BoardGroup, latest: number, previous: number): IndexRow => ({
  symbol, label, group, latest, recent: [previous, latest],
  changePct: ((latest - previous) / previous) * 100,
  changeBp: (latest - previous) * 100,
});

const board = [
  row("^GSPC", "S&P 500", "index", 7766.93, 7712.2),
  row("^RUT", "Russell 2000", "index", 2789.45, 2805.0),
  row("^VIX", "VIX", "volatility", 16.69, 17.31),
  row("^TNX", "10-yr yield", "yield", 5.111, 5.131),
];

describe("TodayBoard", () => {
  it("shows a tile per symbol with its level", () => {
    render(<TodayBoard rows={board} you={0.42} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("7,766.93")).toBeInTheDocument();
    expect(screen.getByText("Russell 2000")).toBeInTheDocument();
  });

  it("colours index moves but not the VIX or yields", () => {
    render(<TodayBoard rows={board} you={0.42} />);
    expect(screen.getByText("+0.7%")).toHaveClass("pos");
    expect(screen.getByText("-0.6%")).toHaveClass("neg");
    const vix = within(screen.getByRole("listitem", { name: "VIX" }));
    expect(vix.getByText("-3.6%")).not.toHaveClass("neg");
  });

  it("shows a yield as a percent level with its move in basis points", () => {
    render(<TodayBoard rows={board} you={0.42} />);
    const tnx = within(screen.getByRole("listitem", { name: "10-yr yield" }));
    expect(tnx.getByText("5.11%")).toBeInTheDocument();
    expect(tnx.getByText("-2 bp")).not.toHaveClass("neg");
  });

  it("says how your investments moved today", () => {
    render(<TodayBoard rows={board} you={0.42} />);
    expect(screen.getByText(/Your investments/)).toHaveTextContent("Your investments +0.4% today");
  });

  it("asks for a refresh when nothing has been fetched", () => {
    render(<TodayBoard rows={[]} you={0} />);
    expect(screen.getByText("No market data yet")).toBeInTheDocument();
  });
});

describe("SectorHeatmap", () => {
  it("draws one tile per sector, in the order given, coloured by its move", () => {
    render(<SectorHeatmap sectors={[
      row("XLK", "Technology", "sector", 101.8, 100),
      row("XLE", "Energy", "sector", 100.06, 100),
      row("XLP", "Consumer staples", "sector", 99.3, 100),
    ]} />);
    const tiles = screen.getAllByRole("listitem");
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Technology +1.8%", "Energy +0.1%", "Consumer staples -0.7%",
    ]);
    expect(tiles[0]).toHaveClass("heat-p3");
    expect(tiles[1]).toHaveClass("heat-0");
    expect(tiles[2]).toHaveClass("heat-n2");
  });

  it("waits for the first refresh", () => {
    render(<SectorHeatmap sectors={[]} />);
    expect(screen.getByText("No sector data yet")).toBeInTheDocument();
  });
});

describe("HoldingsHeatmap", () => {
  it("draws one tile per holding, sized by value", () => {
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
  });

  it("says so when nothing is held", () => {
    render(<HoldingsHeatmap holdings={[]} />);
    expect(screen.getByText("No holdings yet")).toBeInTheDocument();
  });
});
