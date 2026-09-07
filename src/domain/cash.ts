import type { Transaction } from "./types";

export function cashEffect(t: Transaction): number {
  switch (t.type) {
    case "buy": return -(t.quantity * t.price + t.fees);
    case "sell": return t.quantity * t.price - t.fees;
    case "deposit":
    case "dividend":
    case "interest": return t.amount;
    case "withdrawal":
    case "fee": return -t.amount;
    default: return 0;
  }
}

export function cashByAccount(txns: Transaction[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of txns) m.set(t.account_id, (m.get(t.account_id) ?? 0) + cashEffect(t));
  return m;
}

export function totalCash(txns: Transaction[]): number {
  return txns.reduce((sum, t) => sum + cashEffect(t), 0);
}
