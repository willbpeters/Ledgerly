import type { Transaction, Security, Holding } from "./types";
import { cashByAccount } from "./cash";

export interface Position {
  account_id: number; security_id: number;
  shares: number; avgCost: number; costBasis: number;
  lastPrice: number; marketValue: number; unrealized: number; realized: number;
}

function keyOf(accountId: number, securityId: number) { return `${accountId}:${securityId}`; }

/** Fold transactions per (account, security) in date order using average cost. */
export function buildPositions(
  txns: Transaction[],
  latestPrices: Map<number, number>,
): Position[] {
  const relevant = txns
    .filter((t) => t.security_id != null && (t.type === "buy" || t.type === "sell"))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

  const acc = new Map<string, { account_id: number; security_id: number; shares: number; cost: number; realized: number }>();
  for (const t of relevant) {
    const sid = t.security_id as number;
    const k = keyOf(t.account_id, sid);
    const cur = acc.get(k) ?? { account_id: t.account_id, security_id: sid, shares: 0, cost: 0, realized: 0 };
    if (t.type === "buy") {
      cur.shares += t.quantity;
      cur.cost += t.quantity * t.price + t.fees;
    } else {
      const avg = cur.shares > 0 ? cur.cost / cur.shares : 0;
      const qty = Math.min(t.quantity, cur.shares);
      cur.realized += qty * t.price - t.fees - avg * qty;
      cur.shares -= qty;
      cur.cost -= avg * qty;
      if (cur.shares <= 1e-9) { cur.shares = 0; cur.cost = 0; }
    }
    acc.set(k, cur);
  }

  return [...acc.values()].map((p) => {
    const lastPrice = latestPrices.get(p.security_id) ?? 0;
    const avgCost = p.shares > 0 ? p.cost / p.shares : 0;
    const marketValue = p.shares * lastPrice;
    return {
      account_id: p.account_id, security_id: p.security_id,
      shares: p.shares, avgCost, costBasis: p.cost,
      lastPrice, marketValue, unrealized: marketValue - p.cost, realized: p.realized,
    };
  });
}

/** Group positions by security across accounts. Omits zero-share securities. */
export function aggregateHoldings(positions: Position[], securities: Security[]): Holding[] {
  const secById = new Map(securities.map((s) => [s.id, s]));
  const bySec = new Map<number, Holding>();
  for (const p of positions) {
    const s = secById.get(p.security_id);
    if (!s) continue;
    const h = bySec.get(p.security_id) ?? {
      security_id: p.security_id, ticker: s.ticker, type: s.type,
      shares: 0, avgCost: 0, costBasis: 0, lastPrice: p.lastPrice,
      marketValue: 0, unrealized: 0, unrealizedPct: 0, realized: 0,
    };
    h.shares += p.shares;
    h.costBasis += p.costBasis;
    h.marketValue += p.marketValue;
    h.unrealized += p.unrealized;
    h.realized += p.realized;
    h.lastPrice = p.lastPrice;
    bySec.set(p.security_id, h);
  }
  return [...bySec.values()]
    .filter((h) => h.shares > 0)
    .map((h) => ({
      ...h,
      avgCost: h.shares > 0 ? h.costBasis / h.shares : 0,
      unrealizedPct: h.costBasis > 0 ? (h.unrealized / h.costBasis) * 100 : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

/** Per-account total value = cash in account + market value of its positions. */
export function accountMarketValues(positions: Position[], txns: Transaction[]): Map<number, number> {
  const values = new Map<number, number>(cashByAccount(txns));
  for (const p of positions) {
    values.set(p.account_id, (values.get(p.account_id) ?? 0) + p.marketValue);
  }
  return values;
}
