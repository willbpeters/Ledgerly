import type { Account, BankTransaction, Category } from "./types";

/**
 * `~` is a bare number: it matches that amount to the cent, or the same text in
 * a name (a bare "7" should still find 7-Eleven). The rest compare the size of
 * the amount, whichever way the money moved.
 */
export type AmountOp = "~" | ">" | ">=" | "<" | "<=";
export interface ParsedSearch { words: string[]; amounts: { op: AmountOp; value: number }[] }

export interface TxnSearch {
  text: string;
  categoryId: number | "uncategorised" | null;
  accountId: number | null;
}

const AMOUNT = /^(>=|<=|>|<)?\$?(\d[\d,]*(?:\.\d{1,2})?|\.\d{1,2})$/;

function readAmount(token: string): { op: AmountOp; value: number } | null {
  const m = AMOUNT.exec(token);
  if (!m) return null;
  return { op: (m[1] as AmountOp | undefined) ?? "~", value: Number(m[2].replace(/,/g, "")) };
}

export function parseSearch(text: string): ParsedSearch {
  const words: string[] = [];
  const amounts: ParsedSearch["amounts"] = [];
  for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const amount = readAmount(token);
    if (amount) amounts.push(amount);
    // An operator makes it unambiguous; a bare number may also be in a name.
    if (!amount || amount.op === "~") words.push(token);
  }
  return { words, amounts };
}

const cents = (x: number) => Math.round(Math.abs(x) * 100);

function sizeMatches(amount: number, op: Exclude<AmountOp, "~">, value: number): boolean {
  const a = cents(amount), v = cents(value);
  return op === ">" ? a > v : op === ">=" ? a >= v : op === "<" ? a < v : a <= v;
}

/**
 * Every transaction matching the search, newest first. Each word must appear
 * somewhere — payee, description, memo, note, category or account — and each
 * size comparison must hold. The caller decides which transactions are
 * eligible (removed ones, hidden accounts); this only narrows them.
 */
export function searchTransactions(
  txns: BankTransaction[],
  search: TxnSearch,
  { categories, accounts }: { categories: Category[]; accounts: Account[] },
): BankTransaction[] {
  const { words, amounts } = parseSearch(search.text);
  const sizes = amounts.filter((a): a is { op: Exclude<AmountOp, "~">; value: number } => a.op !== "~");
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  return txns
    .filter((t) => {
      if (search.accountId != null && t.account_id !== search.accountId) return false;
      if (search.categoryId === "uncategorised" ? t.category_id != null
        : search.categoryId != null && t.category_id !== search.categoryId) return false;
      if (!sizes.every((s) => sizeMatches(t.amount, s.op, s.value))) return false;
      if (words.length === 0) return true;
      const haystack = [
        t.payee, t.description, t.memo, t.note,
        t.category_id == null ? null : categoryName.get(t.category_id),
        accountName.get(t.account_id),
      ].filter(Boolean).join("\n").toLowerCase();
      return words.every((w) => {
        if (haystack.includes(w)) return true;
        const bare = readAmount(w);
        return bare != null && cents(t.amount) === cents(bare.value);
      });
    })
    // Stable, so rows from the same day keep the order they arrived in.
    .sort((a, b) => b.posted.localeCompare(a.posted));
}
