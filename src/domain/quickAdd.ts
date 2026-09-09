import type { NewTransaction } from "./types";

export interface QuickAddInput {
  accountId: number;
  securityId: number;
  /** YYYY-MM-DD. */
  date: string;
  shares: number;
  pricePerShare: number;
}

/**
 * The rows behind "quick add position".
 *
 * A quick add means "I already hold this" — it backfills a position rather than
 * recording money leaving the account today. The buy on its own has a negative
 * cash effect, so quick-adding a portfolio used to drive cash, and with it the
 * headline net-worth figure, deeply negative. Pairing the buy with a deposit of
 * the same size makes the pair cash-neutral while keeping the cost basis right.
 */
export function quickAddTransactions(input: QuickAddInput): NewTransaction[] {
  const cost = input.shares * input.pricePerShare;
  const base = { account_id: input.accountId, date: input.date, fees: 0 };
  return [
    {
      ...base, security_id: null, type: "deposit",
      quantity: 0, price: 0, amount: cost,
      note: "Quick add: opening cash for the position below",
    },
    {
      ...base, security_id: input.securityId, type: "buy",
      quantity: input.shares, price: input.pricePerShare, amount: cost,
      note: "Quick add",
    },
  ];
}
