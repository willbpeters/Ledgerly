import { describe, it, expect } from "vitest";
import { exposureInputs } from "./Dashboard";
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
