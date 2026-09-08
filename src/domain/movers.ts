import type { Account, Holding } from "./types";

export interface Mover {
  security_id: number;
  ticker: string;
  /** Dollar change since the previous close. */
  change: number;
  changePct: number;
  /** 0..1, relative to the largest absolute move, for drawing a bar. */
  weight: number;
}

/**
 * Today's move per holding, largest first. Holdings with no previous close are
 * left out entirely rather than shown as a flat zero, which would read as
 * "unchanged" when the truth is "not known yet".
 */
export function buildMovers(holdings: Holding[], previousPrices: Map<number, number>): Mover[] {
  const rows = holdings.flatMap((h) => {
    const prev = previousPrices.get(h.security_id);
    if (prev == null || prev <= 0) return [];
    return [{
      security_id: h.security_id,
      ticker: h.ticker,
      change: h.shares * (h.lastPrice - prev),
      changePct: ((h.lastPrice - prev) / prev) * 100,
      weight: 0,
    }];
  });
  const largest = rows.reduce((max, r) => Math.max(max, Math.abs(r.change)), 0);
  return rows
    .map((r) => ({ ...r, weight: largest > 0 ? Math.abs(r.change) / largest : 0 }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

export interface AttentionItem {
  id: string;
  tone: "warn" | "neg";
  title: string;
  body: string;
}

export interface AttentionInput {
  accounts: Account[];
  holdings: Holding[];
  connected: boolean;
  /** Holdings the last sync skipped for having no ticker symbol. */
  skippedHoldings: number;
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Things worth telling the user about, derived from real state only. */
export function attentionItems(i: AttentionInput): AttentionItem[] {
  const now = i.now ?? new Date();
  const items: AttentionItem[] = [];

  if (i.connected) {
    const times = i.accounts
      .filter((a) => a.source === "simplefin" && a.last_synced_at)
      .map((a) => new Date(a.last_synced_at as string).getTime())
      .filter((t) => !Number.isNaN(t));
    const newest = times.length ? Math.max(...times) : null;
    if (newest != null) {
      const days = Math.floor((now.getTime() - newest) / DAY_MS);
      if (days >= 1) {
        items.push({
          id: "stale-sync",
          tone: "warn",
          title: `Last synced ${days} ${days === 1 ? "day" : "days"} ago`,
          body: "Balances and holdings may be out of date.",
        });
      }
    }
  }

  if (i.skippedHoldings > 0) {
    items.push({
      id: "skipped-holdings",
      tone: "warn",
      title: `${i.skippedHoldings} synced holding${i.skippedHoldings === 1 ? "" : "s"} had no ticker`,
      body: "They were left out of your totals.",
    });
  }

  const unpriced = i.holdings.filter((h) => !h.lastPrice).length;
  if (unpriced > 0) {
    items.push({
      id: "no-price",
      tone: "warn",
      title: `${unpriced} holding${unpriced === 1 ? "" : "s"} have no price yet`,
      body: "Refresh prices, or set one by hand in Activity.",
    });
  }

  return items;
}
