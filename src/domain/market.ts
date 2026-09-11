import type {
  Security, SecurityProfile, NewsItem, EarningsEvent, IndexQuote,
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
  nextEarnings?: EarningsEvent;
  lastEarnings?: ReportedEarnings;
}

export interface IndexRow { symbol: string; label: string; changePct: number; }
export interface CalendarDay { date: string; tickers: string[]; }

export interface MarketView {
  indices: IndexRow[];
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

  const fetchTimes = i.news.map((n) => n.fetched_at).sort();
  return {
    indices: i.indices.map((q) => ({
      symbol: q.symbol, label: q.label,
      changePct: q.previous === 0 ? 0 : ((q.latest - q.previous) / q.previous) * 100,
    })),
    companies,
    funds,
    calendar,
    newestFetch: fetchTimes.length ? fetchTimes[fetchTimes.length - 1] : null,
  };
}
