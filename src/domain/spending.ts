import type { BankTransaction, Budget, Category } from "./types";

/** First and last day of a `YYYY-MM` month, inclusive. */
export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one, leap years included.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Move `by` months, wrapping the year. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function thisMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The limit in force for a category in a month: a figure set for that month
 * wins over the every-month default.
 */
export function limitFor(budgets: Budget[], categoryId: number, month: string): number | null {
  const specific = budgets.find((b) => b.category_id === categoryId && b.month === month);
  if (specific) return specific.limit_amount;
  const fallback = budgets.find((b) => b.category_id === categoryId && b.month == null);
  return fallback ? fallback.limit_amount : null;
}

export interface CategorySpend {
  category: Category;
  /** Money out, as a positive number, net of refunds. */
  spent: number;
  count: number;
  limit: number | null;
  /** limit - spent, or null when there is no limit. */
  remaining: number | null;
  /** 0..1, capped, for a progress bar. */
  progress: number;
  over: boolean;
}

export interface MonthSummary {
  month: string;
  spent: number;
  income: number;
  net: number;
  /** Moved between your own accounts; excluded from spending and income. */
  transferred: number;
  budgeted: number;
  uncategorisedCount: number;
  uncategorisedTotal: number;
  categories: CategorySpend[];
}

/**
 * What happened in one month.
 *
 * Spending is reported as a positive number, because "you spent $157" reads
 * better than "-157". A refund reduces its category rather than counting as
 * income, and transfers between your own accounts are left out of both sides
 * so moving money never looks like earning or spending it.
 */
export function summariseMonth(
  txns: BankTransaction[],
  categories: Category[],
  budgets: Budget[],
  month: string,
): MonthSummary {
  const { from, to } = monthWindow(month);
  const inMonth = txns.filter((t) => t.posted >= from && t.posted <= to);
  const byId = new Map(categories.map((c) => [c.id, c]));

  const totals = new Map<number, { spent: number; count: number }>();
  let income = 0;
  let transferred = 0;
  let uncategorisedCount = 0;
  let uncategorisedTotal = 0;

  for (const t of inMonth) {
    const category = t.category_id == null ? null : byId.get(t.category_id) ?? null;
    if (category?.kind === "transfer") {
      transferred += Math.abs(t.amount) / 2; // each leg is counted once
      continue;
    }
    if (category?.kind === "income") {
      income += t.amount;
      continue;
    }
    if (category == null) {
      if (t.amount < 0) {
        uncategorisedCount += 1;
        uncategorisedTotal += -t.amount;
      } else {
        income += t.amount;
      }
      continue;
    }
    const row = totals.get(category.id) ?? { spent: 0, count: 0 };
    row.spent += -t.amount; // a refund is positive, so it reduces the total
    row.count += 1;
    totals.set(category.id, row);
  }

  const rows: CategorySpend[] = categories
    .filter((c) => c.kind === "spending")
    .map((category) => {
      const { spent, count } = totals.get(category.id) ?? { spent: 0, count: 0 };
      const limit = limitFor(budgets, category.id, month);
      return {
        category,
        spent,
        count,
        limit,
        remaining: limit == null ? null : limit - spent,
        progress: limit == null || limit <= 0 ? 0 : Math.min(1, Math.max(0, spent / limit)),
        over: limit != null && spent > limit,
      };
    })
    .sort((a, b) => b.spent - a.spent || a.category.sort - b.category.sort);

  const spent = rows.reduce((s, r) => s + r.spent, 0);
  const budgeted = categories
    .filter((c) => c.kind === "spending")
    .reduce((s, c) => s + (limitFor(budgets, c.id, month) ?? 0), 0);

  return {
    month, spent, income, net: income - spent, transferred, budgeted,
    uncategorisedCount, uncategorisedTotal, categories: rows,
  };
}
