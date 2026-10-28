import { describe, it, expect } from "vitest";
import { CATEGORY_TOKENS, categoryColour, categoryToken } from "./categoryColour";

describe("categoryToken", () => {
  it("passes a cat-N token through", () => {
    expect(categoryToken("cat-11")).toBe("cat-11");
    expect(categoryToken("cat-1")).toBe("cat-1");
  });

  it("maps a legacy chart-N token to the same cat-N", () => {
    expect(categoryToken("chart-3")).toBe("cat-3");
    expect(categoryToken("chart-6")).toBe("cat-6");
  });

  it("folds a number past twelve back into the twelve colours", () => {
    expect(categoryToken("cat-13")).toBe("cat-1");
    expect(categoryToken("cat-24")).toBe("cat-12");
  });

  it("falls back to the first colour for anything it cannot read", () => {
    expect(categoryToken("")).toBe("cat-1");
    expect(categoryToken("teal")).toBe("cat-1");
    expect(categoryToken("cat-0")).toBe("cat-1");
    expect(categoryToken(null)).toBe("cat-1");
    expect(categoryToken(undefined)).toBe("cat-1");
  });
});

describe("categoryColour", () => {
  it("is the CSS variable for the token, so it follows the theme", () => {
    expect(categoryColour("cat-11")).toBe("var(--cat-11)");
    expect(categoryColour("chart-3")).toBe("var(--cat-3)");
  });
});

describe("CATEGORY_TOKENS", () => {
  it("lists all twelve colours in order", () => {
    expect(CATEGORY_TOKENS).toEqual(Array.from({ length: 12 }, (_, i) => `cat-${i + 1}`));
  });
});
