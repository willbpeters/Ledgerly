import { describe, it, expect } from "vitest";
import { titleFor } from "./CommandBar";

describe("titleFor", () => {
  it("names the Goals screen", () => {
    expect(titleFor("/goals")).toBe("Goals");
  });

  it("names the Markets screen", () => {
    expect(titleFor("/markets")).toBe("Markets");
  });
});
