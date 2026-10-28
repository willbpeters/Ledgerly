import type {
  Security, SecurityProfile, NewsItem, EarningsEvent, IndexQuote, BoardGroup,
} from "./types";

/** How far ahead the earnings strip looks. */
export const CALENDAR_DAYS = 14;

export interface ReportedEarnings extends EarningsEvent {
  /** Actual at or above consensus. Undefined when either figure is missing. */
  beat?: boolean;
}

export interface MarketRow {
  security_id: number;
  ticker: string;
  name: string | null;
  value: number;
  dayChangePct: number;
  tracks: string | null;
  news: NewsItem[];
  /** Yahoo's quote type (EQUITY, ETF, MUTUALFUND), or null before a profile is fetched. */
  quoteType: string | null;
  nextEarnings?: EarningsEvent;
  lastEarnings?: ReportedEarnings;
}

/** How "your investments" moved today, and over how much of them. */
export interface TodayMove {
  /** `all`: the whole portfolio. `priced`: only what has a price for today. `pending`: nothing has yet. */
  scope: "all" | "priced" | "pending";
  pct: number | null;
  /** Share of holdings' value, 0..1, still waiting for today's price. */
  pendingShare: number;
  /** What the priced part is called, for the `priced` scope. */
  pricedLabel: string;
}

// A move this small on a mutual fund is not a move: it is yesterday's NAV
// standing in for a today that has not been published yet.
const UNPRICED_PCT = 0.005;

function isWeekdayInNewYork(now: Date): boolean {
  const day = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  return day !== 0 && day !== 6;
}

/**
 * Today's move for the Markets header, honest about mutual funds.
 *
 * A mutual fund prices once a day, after the close. Until then the latest
 * stored price for it is yesterday's NAV (SimpleFIN re-dates it to today), so
 * its move reads 0% and a portfolio mostly in mutual funds shows +0.0% on a day
 * the market is up. So on a weekday, mutual funds with no move are treated as
 * not yet priced: the figure covers what has priced, and says how much is
 * waiting. Once they move — or at the weekend — it is the whole portfolio's
 * figure, the same one the Dashboard shows.
 */
export function todayMove(rows: MarketRow[], allPct: number, now: Date): TodayMove {
  const waiting = isWeekdayInNewYork(now)
    ? rows.filter((r) => r.quoteType === "MUTUALFUND" && Math.abs(r.dayChangePct) < UNPRICED_PCT)
    : [];
  const all: TodayMove = { scope: "all", pct: allPct, pendingShare: 0, pricedLabel: "Your investments" };
  if (waiting.length === 0) return all;

  const total = rows.reduce((s, r) => s + r.value, 0);
  const priced = rows.filter((r) => !waiting.includes(r) && r.value > 0);
  const pricedValue = priced.reduce((s, r) => s + r.value, 0);
  const pendingShare = total > 0 ? (total - pricedValue) / total : 0;
  if (pricedValue <= 0) return { scope: "pending", pct: null, pendingShare, pricedLabel: "" };

  const hasEtf = priced.some((r) => r.quoteType === "ETF");
  return {
    scope: "priced",
    pct: priced.reduce((s, r) => s + r.value * r.dayChangePct, 0) / pricedValue,
    pendingShare,
    pricedLabel: hasEtf ? "Your stocks and ETFs" : "Your stocks",
  };
}

export interface IndexRow {
  symbol: string; label: string; group: BoardGroup;
  latest: number; changePct: number;
  /** Change in basis points. Meaningful for yields, which are quoted in percent. */
  changeBp: number;
  recent: number[];
}
export interface CalendarDay { date: string; tickers: string[]; }

export interface MarketView {
  /** The Today board, in the order the Rust symbol table gives. */
  indices: IndexRow[];
  /** The sector funds, biggest move up first, for the heatmap. */
  sectors: IndexRow[];
  companies: MarketRow[];
  funds: MarketRow[];
  calendar: CalendarDay[];
  /** Newest `fetched_at` across all cached news, or null before a first refresh. */
  newestFetch: string | null;
}

export interface MarketInputs {
  securities: Security[];
  profiles: SecurityProfile[];
  news: NewsItem[];
  earnings: EarningsEvent[];
  indices: IndexQuote[];
  /** Market value per security_id. A security absent here is not held. */
  holdings: Map<number, number>;
  /** Day change as a percentage, per security_id. */
  dayChange: Map<number, number>;
  /** Today as `YYYY-MM-DD`. Passed in so the function stays pure. */
  today: string;
}

function shiftDays(date: string, by: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/**
 * Assemble everything the Markets screen renders.
 *
 * A security with no profile yet is treated as a company: the alternative is
 * hiding a holding until its first profile fetch lands, which reads as data
 * loss. Funds are only ever those explicitly typed as ETF or MUTUALFUND.
 */
export function buildMarketView(i: MarketInputs): MarketView {
  const profileOf = new Map(i.profiles.map((p) => [p.security_id, p]));
  const newsOf = new Map<number, NewsItem[]>();
  for (const n of i.news) {
    const list = newsOf.get(n.security_id) ?? [];
    list.push(n);
    newsOf.set(n.security_id, list);
  }
  for (const list of newsOf.values()) list.sort((a, b) => b.published.localeCompare(a.published));

  const held = i.securities.filter((s) => (i.holdings.get(s.id) ?? 0) > 0);

  const row = (s: Security): MarketRow => {
    const p = profileOf.get(s.id);
    const mine = i.earnings.filter((e) => e.security_id === s.id);
    const ahead = mine.filter((e) => e.report_date >= i.today)
      .sort((a, b) => a.report_date.localeCompare(b.report_date));
    const behind = mine.filter((e) => e.report_date < i.today && e.eps_actual != null)
      .sort((a, b) => b.report_date.localeCompare(a.report_date));
    const last = behind[0];
    return {
      security_id: s.id,
      ticker: s.ticker,
      name: p?.long_name ?? s.name,
      value: i.holdings.get(s.id) ?? 0,
      dayChangePct: i.dayChange.get(s.id) ?? 0,
      tracks: p?.tracks ?? null,
      news: newsOf.get(s.id) ?? [],
      quoteType: p?.quote_type ?? null,
      nextEarnings: ahead[0],
      lastEarnings: last && {
        ...last,
        beat: last.eps_actual != null && last.eps_estimate != null
          ? last.eps_actual >= last.eps_estimate
          : undefined,
      },
    };
  };

  const isFund = (s: Security) => {
    const q = profileOf.get(s.id)?.quote_type;
    return q === "ETF" || q === "MUTUALFUND";
  };

  // Biggest mover first: alphabetical would bury what the screen exists to show.
  const companies = held.filter((s) => !isFund(s)).map(row)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct));
  const funds = held.filter(isFund).map(row)
    .sort((a, b) => b.value - a.value);

  const horizon = shiftDays(i.today, CALENDAR_DAYS);
  const byDate = new Map<string, string[]>();
  for (const s of held) {
    for (const e of i.earnings) {
      if (e.security_id !== s.id) continue;
      if (e.report_date < i.today || e.report_date > horizon) continue;
      const list = byDate.get(e.report_date) ?? [];
      if (!list.includes(s.ticker)) list.push(s.ticker);
      byDate.set(e.report_date, list);
    }
  }
  const calendar: CalendarDay[] = [...byDate.entries()]
    .map(([date, tickers]) => ({ date, tickers }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows: IndexRow[] = i.indices.map((q) => ({
    symbol: q.symbol, label: q.label, group: q.group, latest: q.latest, recent: q.recent,
    changePct: q.previous === 0 ? 0 : ((q.latest - q.previous) / q.previous) * 100,
    // Yields are quoted in percent (5.11 = 5.11%), so a point of change is 100 bp.
    changeBp: (q.latest - q.previous) * 100,
  }));

  const fetchTimes = i.news.map((n) => n.fetched_at).sort();
  return {
    indices: rows.filter((r) => r.group !== "sector"),
    sectors: rows.filter((r) => r.group === "sector").sort((a, b) => b.changePct - a.changePct),
    companies,
    funds,
    calendar,
    newestFetch: fetchTimes.length ? fetchTimes[fetchTimes.length - 1] : null,
  };
}
