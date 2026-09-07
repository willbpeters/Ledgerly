import type { Holding, Account, AllocationSlice } from "./types";

const TYPE_LABEL: Record<string, string> = { stock: "Stocks", etf: "ETFs" };

function withPct(entries: { label: string; value: number }[]): AllocationSlice[] {
  const total = entries.reduce((s, e) => s + e.value, 0);
  return entries
    .filter((e) => e.value > 0)
    .map((e) => ({ ...e, pct: total > 0 ? (e.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

export function allocationByType(holdings: Holding[], cash: number): AllocationSlice[] {
  const byType = new Map<string, number>();
  for (const h of holdings) {
    const label = TYPE_LABEL[h.type] ?? h.type;
    byType.set(label, (byType.get(label) ?? 0) + h.marketValue);
  }
  const entries = [...byType.entries()].map(([label, value]) => ({ label, value }));
  if (cash > 0) entries.push({ label: "Cash", value: cash });
  return withPct(entries);
}

export function allocationByAccount(
  accountValues: Map<number, number>,
  accounts: Account[],
): AllocationSlice[] {
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const entries = [...accountValues.entries()].map(([id, value]) => ({
    label: nameById.get(id) ?? `Account ${id}`, value,
  }));
  return withPct(entries);
}
