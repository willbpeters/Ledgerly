import { describe, it, expect } from "vitest";
import { mean, variance, stdev, covariance, fit } from "./regression";

describe("summary statistics", () => {
  it("takes the mean of a series", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("gives a constant series exactly zero variance, not a rounding artefact", () => {
    expect(variance([5, 5, 5, 5])).toBe(0);
    expect(stdev([5, 5, 5, 5])).toBe(0);
  });

  it("uses the sample convention, dividing by n-1", () => {
    // [2,4,4,4,5,5,7,9]: deviations squared sum to 32, over n-1 = 7.
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 12);
  });

  it("treats the covariance of a series with itself as its variance", () => {
    const xs = [1, 4, 2, 8, 5, 7];
    expect(covariance(xs, xs)).toBeCloseTo(variance(xs)!, 12);
  });

  it("returns null rather than a number when there is nothing to measure", () => {
    expect(mean([])).toBeNull();
    expect(variance([3])).toBeNull();
    expect(stdev([])).toBeNull();
    expect(covariance([1], [1])).toBeNull();
  });

  it("throws on mismatched lengths, because that is a bug and not a data condition", () => {
    expect(() => covariance([1, 2, 3], [1, 2])).toThrow(/same length/);
  });
});

describe("fit", () => {
  it("recovers the slope and intercept of a straight line", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 2 * x + 3);
    const f = fit(xs, ys)!;
    expect(f.slope).toBeCloseTo(2, 12);
    expect(f.intercept).toBeCloseTo(3, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it("fits a series against itself as slope 1, intercept 0", () => {
    const xs = [0.01, -0.02, 0.005, 0.03, -0.01, 0.002];
    const f = fit(xs, xs)!;
    expect(f.slope).toBeCloseTo(1, 12);
    expect(f.intercept).toBeCloseTo(0, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it("fits a series against its negation as a perfect fit with a negative slope", () => {
    const xs = [0.01, -0.02, 0.005, 0.03, -0.01, 0.002];
    const f = fit(xs, xs.map((x) => -x))!;
    expect(f.slope).toBeCloseTo(-1, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it("refuses to regress against a flat independent series", () => {
    expect(fit([1, 1, 1, 1], [2, 4, 6, 8])).toBeNull();
  });

  it("says the market explains none of a series that never moves", () => {
    const f = fit([0.01, -0.02, 0.005, 0.03], [7, 7, 7, 7])!;
    expect(f.slope).toBe(0);
    expect(f.r2).toBe(0);
  });

  it("returns null for fewer than two points", () => {
    expect(fit([1], [2])).toBeNull();
  });
});

describe("non-finite input", () => {
  it("returns null rather than propagating a NaN through the mean", () => {
    expect(mean([1, NaN, 3])).toBeNull();
    expect(mean([1, Infinity, 3])).toBeNull();
  });

  it("returns null rather than propagating a NaN through the spread", () => {
    expect(variance([1, NaN, 3])).toBeNull();
    expect(stdev([1, -Infinity, 3])).toBeNull();
    expect(covariance([1, 2, 3], [1, NaN, 3])).toBeNull();
  });

  it("refuses to fit a line through a series containing a non-finite value", () => {
    const xs = [1, 2, 3, 4];
    expect(fit(xs, [2, NaN, 6, 8])).toBeNull();
    expect(fit([1, Infinity, 3, 4], [2, 4, 6, 8])).toBeNull();
  });

  it("still answers normally for ordinary finite input", () => {
    // The guard must not change any correct answer.
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(fit([1, 2, 3, 4, 5], [5, 7, 9, 11, 13])!.slope).toBeCloseTo(2, 12);
  });
});
