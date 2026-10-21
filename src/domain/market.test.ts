import { describe, it, expect } from "vitest";
import { buildMarketView, todayMove, type MarketRow } from "./market";
import type { Security, SecurityProfile, NewsItem, EarningsEvent, IndexQuote } from "./types";

const securities: Security[] = [
  { id: 1, ticker: "MU", name: null, type: "stock", currency: "USD" },
  { id: 2, ticker: "GOOG", name: null, type: "stock", currency: "USD" },
  { id: 3, ticker: "SWPPX", name: null, type: "etf", currency: "USD" },
];
const profiles: SecurityProfile[] = [
  { security_id: 1, long_name: "Micron", sector: "Technology", quote_type: "EQUITY", tracks: null },
  { security_id: 2, long_name: "Alphabet", sector: "Technology", quote_type: "EQUITY", tracks: null },
  { security_id: 3, long_name: "Schwab S&P 500", sector: null, quote_type: "MUTUALFUND", tracks: "S&P 500" },
];
const news = (security_id: number, title: string, published: string): NewsItem =>
  ({ security_id, title, summary: null, url: `https://x.test/${title}`, publisher: "reuters.com",
     published, fetched_at: "2026-09-10T12:00:00Z" });
const holdings = new Map([[1, 900], [2, 1400], [3, 3400]]);
const dayChange = new Map([[1, 3.8], [2, 0.9], [3, 0.42]]);
const quote = (symbol: string, label: string, group: IndexQuote["group"], latest: number, previous: number): IndexQuote =>
  ({ symbol, label, group, latest, previous, recent: [previous, latest] });
const indices: IndexQuote[] = [quote("^GSPC", "S&P 500", "index", 101, 100)];

const base = {
  securities, profiles, holdings, dayChange, indices,
  news: [] as NewsItem[], earnings: [] as EarningsEvent[],
  today: "2026-09-10",
};

describe("buildMarketView", () => {
  it("splits holdings into companies and funds by quote_type", () => {
    const v = buildMarketView(base);
    expect(v.companies.map((r) => r.ticker)).toEqual(["MU", "GOOG"]);
    expect(v.funds.map((r) => r.ticker)).toEqual(["SWPPX"]);
    expect(v.funds[0].tracks).toBe("S&P 500");
  });

  it("orders companies by size of move, not alphabetically", () => {
    const v = buildMarketView({ ...base, dayChange: new Map([[1, -0.4], [2, 5.2], [3, 0]]) });
    expect(v.companies.map((r) => r.ticker)).toEqual(["GOOG", "MU"]);
  });

  it("a big fall outranks a small rise", () => {
    const v = buildMarketView({ ...base, dayChange: new Map([[1, -6.0], [2, 1.0], [3, 0]]) });
    expect(v.companies[0].ticker).toBe("MU");
  });

  it("attaches each company's newest headlines", () => {
    const v = buildMarketView({ ...base, news: [
      news(1, "older", "2026-09-09T10:00:00Z"),
      news(1, "newest", "2026-09-10T10:00:00Z"),
      news(2, "alphabet news", "2026-09-10T09:00:00Z"),
    ]});
    const mu = v.companies.find((r) => r.ticker === "MU")!;
    expect(mu.news.map((n) => n.title)).toEqual(["newest", "older"]);
  });

  it("a holding with no news still appears, so a quiet row never looks like a bug", () => {
    const v = buildMarketView(base);
    expect(v.companies).toHaveLength(2);
    expect(v.companies[0].news).toEqual([]);
  });

  it("a security with no profile yet is treated as a company rather than dropped", () => {
    const v = buildMarketView({ ...base, profiles: [] });
    expect(v.companies.map((r) => r.ticker)).toEqual(["MU", "GOOG", "SWPPX"]);
    expect(v.funds).toEqual([]);
  });

  it("leaves out securities with no position", () => {
    const v = buildMarketView({ ...base, holdings: new Map([[1, 900]]) });
    expect(v.companies.map((r) => r.ticker)).toEqual(["MU"]);
    expect(v.funds).toEqual([]);
  });

  it("picks the next report ahead and the most recent one behind", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: "Feb 2026", report_date: "2026-03-20",
        eps_actual: 1.18, eps_estimate: 1.21, estimate_count: null },
      { security_id: 1, fiscal_period: "May 2026", report_date: "2026-09-08",
        eps_actual: 1.79, eps_estimate: 1.60, estimate_count: null },
      { security_id: 1, fiscal_period: "Aug 2026", report_date: "2026-09-23",
        eps_actual: null, eps_estimate: 1.92, estimate_count: 18 },
    ];
    const mu = buildMarketView({ ...base, earnings }).companies.find((r) => r.ticker === "MU")!;
    expect(mu.nextEarnings?.report_date).toBe("2026-09-23");
    expect(mu.lastEarnings?.report_date).toBe("2026-09-08");
    expect(mu.lastEarnings?.beat).toBe(true);
  });

  it("marks a miss as a miss", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: "Feb 2026", report_date: "2026-09-08",
        eps_actual: 1.18, eps_estimate: 1.21, estimate_count: null },
    ];
    const mu = buildMarketView({ ...base, earnings }).companies.find((r) => r.ticker === "MU")!;
    expect(mu.lastEarnings?.beat).toBe(false);
  });

  it("says nothing about beat or miss when a figure is missing", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: null, report_date: "2026-09-08",
        eps_actual: 1.18, eps_estimate: null, estimate_count: null },
    ];
    const mu = buildMarketView({ ...base, earnings }).companies.find((r) => r.ticker === "MU")!;
    expect(mu.lastEarnings?.beat).toBeUndefined();
  });

  it("builds a calendar of reports within the next 14 days only", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: null, report_date: "2026-09-12",
        eps_actual: null, eps_estimate: 1.92, estimate_count: null },
      { security_id: 2, fiscal_period: null, report_date: "2026-11-01",
        eps_actual: null, eps_estimate: 2.0, estimate_count: null },
    ];
    const v = buildMarketView({ ...base, earnings });
    expect(v.calendar.map((d) => d.date)).toEqual(["2026-09-12"]);
    expect(v.calendar[0].tickers).toEqual(["MU"]);
  });

  it("turns index closes into a percentage move", () => {
    const v = buildMarketView(base);
    expect(v.indices[0].label).toBe("S&P 500");
    expect(v.indices[0].changePct).toBeCloseTo(1.0, 5);
  });

  it("keeps the board in its own order and sorts the sectors by today's move", () => {
    const v = buildMarketView({ ...base, indices: [
      quote("^GSPC", "S&P 500", "index", 101, 100),
      quote("XLE", "Energy", "sector", 99, 100),
      quote("^VIX", "VIX", "volatility", 16, 17),
      quote("XLK", "Technology", "sector", 102, 100),
      quote("^TNX", "10-yr yield", "yield", 5.11, 5.13),
    ] });
    expect(v.indices.map((r) => r.symbol)).toEqual(["^GSPC", "^VIX", "^TNX"]);
    expect(v.sectors.map((r) => r.label)).toEqual(["Technology", "Energy"]);
  });

  it("measures a yield's move in basis points", () => {
    const v = buildMarketView({ ...base, indices: [quote("^TNX", "10-yr yield", "yield", 5.11, 5.13)] });
    expect(v.indices[0].changeBp).toBeCloseTo(-2, 5);
    expect(v.indices[0]).toMatchObject({ latest: 5.11, group: "yield", recent: [5.13, 5.11] });
  });

  it("reports the newest fetch time so staleness can be shown", () => {
    const v = buildMarketView({ ...base, news: [
      { ...news(1, "a", "2026-09-09T10:00:00Z"), fetched_at: "2026-09-09T12:00:00Z" },
      { ...news(2, "b", "2026-09-10T10:00:00Z"), fetched_at: "2026-09-10T12:00:00Z" },
    ]});
    expect(v.newestFetch).toBe("2026-09-10T12:00:00Z");
  });

  it("has no fetch time at all before the first refresh", () => {
    expect(buildMarketView(base).newestFetch).toBeNull();
  });
});

describe("todayMove", () => {
  const r = (ticker: string, value: number, dayChangePct: number, mutualFund = false): MarketRow =>
    ({ security_id: ticker.length, ticker, name: null, value, dayChangePct, tracks: null, news: [],
       quoteType: mutualFund ? "MUTUALFUND" : "EQUITY" });
  // A Wednesday, 2 pm in New York: the market is open, mutual funds have not priced.
  const midday = new Date("2026-10-21T18:00:00Z");
  const saturday = new Date("2026-10-24T18:00:00Z");

  it("measures only what has priced while the mutual funds still show yesterday's price", () => {
    const m = todayMove([r("SWLGX", 9000, 0, true), r("MU", 600, 2), r("GOOG", 400, -1)], 0.04, midday);
    expect(m.scope).toBe("priced");
    expect(m.pct).toBeCloseTo((600 * 2 + 400 * -1) / 1000, 6);
    expect(m.pendingShare).toBeCloseTo(0.9, 6);
    expect(m.pricedLabel).toBe("Your stocks");
  });

  it("says ETFs are in the priced part when there are some", () => {
    const etf = { ...r("VTI", 500, 1), quoteType: "ETF" };
    const m = todayMove([r("SWLGX", 9000, 0, true), etf], 0, midday);
    expect(m.pricedLabel).toBe("Your stocks and ETFs");
  });

  it("uses the whole portfolio once the mutual funds have moved", () => {
    const m = todayMove([r("SWLGX", 9000, 0.8, true), r("MU", 600, 2)], 0.85, midday);
    expect(m).toMatchObject({ scope: "all", pct: 0.85, pendingShare: 0 });
  });

  it("uses the whole portfolio at the weekend, when nothing is waiting to price", () => {
    const m = todayMove([r("SWLGX", 9000, 0, true), r("MU", 600, 2)], 0.13, saturday);
    expect(m).toMatchObject({ scope: "all", pct: 0.13 });
  });

  it("has no figure to give when everything held is a mutual fund still waiting", () => {
    const m = todayMove([r("SWLGX", 9000, 0, true)], 0, midday);
    expect(m.scope).toBe("pending");
    expect(m.pct).toBeNull();
  });
});
