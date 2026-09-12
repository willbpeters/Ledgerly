import { describe, it, expect } from "vitest";
import { exposureInputs, CHART_MODES } from "./Dashboard";
import type { Aligned } from "../../domain/returns";
import type { PortfolioSummary } from "../../domain/types";

// `Dashboard` itself pulls in several data hooks, recharts, and a colour hook,
// so it is mocked here only indirectly: `exposureInputs` is the tiny pure
// seam that wires the risk maths' cash input, pulled out specifically so this
// invariant can be pinned without mounting the whole screen.
describe("exposureInputs", () => {
  it("gives the risk maths cash without netting off credit-card debt", () => {
    // Debt does not reduce market exposure, it leverages it. Netting it here
    // would make borrowing look like risk reduction.
    const summary = { cash: 5000, liabilities: -1500 } as PortfolioSummary;
    const aligned = { assets: [], benchmark: [] } as unknown as Aligned;

    expect(exposureInputs(aligned, summary)).toEqual(
      expect.objectContaining({ cash: 5000 }),
    );
  });
});

// The chart's dataKey and its caveat are two encodings of the same mode
// choice, kept in one table specifically so they cannot drift apart — a fix
// applied to one and not the other, or a third mode added carelessly, would
// otherwise plot one line while describing another.
describe("CHART_MODES", () => {
  it("plots a different field, and states a different caveat, per mode", () => {
    expect(CHART_MODES.networth.dataKey).toBe("value");
    expect(CHART_MODES.invested.dataKey).toBe("invested");
    expect(CHART_MODES.networth.dataKey).not.toBe(CHART_MODES.invested.dataKey);
    expect(CHART_MODES.networth.subtitle).not.toBe(CHART_MODES.invested.subtitle);

    // The investments line is not rebuilt from cash movements, so its
    // subtitle claiming otherwise would be a false caveat — worse than none.
    expect(CHART_MODES.networth.subtitle).toMatch(/cash movements/);
    expect(CHART_MODES.invested.subtitle).not.toMatch(/cash movements/);
  });
});
