import type { BankTransaction } from "./types";

/**
 * Split transactions. A split row's own `category_id` is null; its pieces are
 * what count. Anything that totals or filters by category must read
 * transactions through `piecesOf` or `inCategory`, or a split purchase would
 * look uncategorised.
 */

export interface Piece {
  category_id: number | null;
  amount: number;
  /** Set on the piece `piecesOf` adds for what the pieces no longer cover after a later sync changed the amount. */
  remainder?: true;
}

// Rounds half a cent away from zero, as Rust's f64::round does (Math.round
// takes -0.125 * 100 to -12, Rust to -13), so these checks agree with set_splits.
const cents = (x: number) => Math.sign(x) * Math.round(Math.abs(x) * 100);

/**
 * What the pieces no longer cover, with the transaction's sign: 0 unless a
 * later sync changed the amount after the owner split it (a pending tip
 * settling, say). Compared in cents, so a float crumb is never a remainder.
 */
export function splitRemainder(t: BankTransaction): number {
  if (t.splits.length === 0) return 0;
  const left = cents(t.amount) - t.splits.reduce((s, p) => s + cents(p.amount), 0);
  return left === 0 ? 0 : left / 100;
}

/**
 * The pieces a transaction counts as: the whole of it when it is not split;
 * otherwise its pieces, plus an uncategorised piece for anything they no
 * longer cover, so the month's totals always add up to what the bank says.
 */
export function piecesOf(t: BankTransaction): Piece[] {
  if (t.splits.length === 0) return [{ category_id: t.category_id, amount: t.amount }];
  const pieces: Piece[] = t.splits.map((s) => ({ category_id: s.category_id, amount: s.amount }));
  const left = splitRemainder(t);
  if (left !== 0) pieces.push({ category_id: null, amount: left, remainder: true });
  return pieces;
}

/** Whether any piece of the transaction is in that category. */
export function inCategory(t: BankTransaction, category: number | "uncategorised"): boolean {
  return piecesOf(t).some((p) =>
    category === "uncategorised" ? p.category_id == null : p.category_id === category);
}

/** Why a split cannot be saved yet. "short": some of it is not assigned;
 *  "over": the pieces come to more than the transaction. */
export type SplitProblem = "too-few" | "no-amount" | "short" | "over";

export interface SplitCheck {
  /** Still to assign, with the transaction's sign; 0 when it adds up. */
  left: number;
  problem: SplitProblem | null;
}

/**
 * The rules `store::set_splits` enforces in Rust, checked as the owner types
 * so Save can stay disabled until they hold: at least two pieces, none zero,
 * adding up to the transaction to the cent. An empty list is "too-few" here:
 * unsplitting is a separate action, though Rust accepts `[]` as unsplit. An
 * amount that is not a number (an empty or unparsable field) counts as missing.
 */
export function validateSplits(total: number, pieces: Piece[]): SplitCheck {
  const totalCents = cents(total);
  const leftCents = totalCents
    - pieces.reduce((s, p) => s + (Number.isFinite(p.amount) ? cents(p.amount) : 0), 0);
  // Never -0: it reads as zero to a person but not to toEqual.
  const left = leftCents === 0 ? 0 : leftCents / 100;
  if (pieces.length < 2) return { left, problem: "too-few" };
  if (pieces.some((p) => !Number.isFinite(p.amount) || cents(p.amount) === 0)) return { left, problem: "no-amount" };
  if (leftCents === 0) return { left, problem: null };
  return { left, problem: Math.sign(leftCents) === Math.sign(totalCents) ? "short" : "over" };
}
