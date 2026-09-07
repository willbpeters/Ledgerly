import type { TxnType } from "../../domain/types";

export interface ColumnMap {
  date: string; type: string; ticker: string;
  quantity: string; price: string; amount: string; fees: string;
}
/** A parsed row ready to import; carries the raw ticker so the caller can
 *  resolve it to a security_id via the backend before inserting. */
export interface StagedTxn {
  account_id: number; tickerRaw: string; security_id: number | null;
  type: TxnType; date: string; quantity: number; price: number; amount: number;
  fees: number; note: string | null;
}
export interface RowError { line: number; reason: string; }

const TYPES: TxnType[] = ["buy","sell","dividend","deposit","withdrawal","fee","interest"];
const NEEDS_SECURITY: TxnType[] = ["buy","sell","dividend"];
const NEEDS_QTY_PRICE: TxnType[] = ["buy","sell"];

/** Parse a possibly-formatted number cell. Returns null for empty or
 *  non-numeric input so callers can distinguish "absent/garbage" from 0. */
function parseNum(v: unknown): number | null {
  const s = String(v ?? "").replace(/[$,]/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function rowsToTransactions(
  rows: Record<string, string>[],
  map: ColumnMap,
  accountId: number,
): { valid: StagedTxn[]; errors: RowError[] } {
  const valid: StagedTxn[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    // rows[] are data rows only (PapaParse strips the header), so the line in
    // the user's file is the data index + 2 (1 for the header, 1 for 1-based).
    const line = i + 2;
    const date = (row[map.date] ?? "").trim();
    const rawType = (row[map.type] ?? "").trim().toLowerCase();
    const ticker = (row[map.ticker] ?? "").trim().toUpperCase();

    if (!date) { errors.push({ line, reason: "Missing date" }); return; }
    if (!TYPES.includes(rawType as TxnType)) { errors.push({ line, reason: `Unknown type "${rawType}"` }); return; }
    const type = rawType as TxnType;
    if (NEEDS_SECURITY.includes(type) && !ticker) { errors.push({ line, reason: `Type "${type}" needs a ticker` }); return; }

    const fees = parseNum(row[map.fees]) ?? 0;
    if (fees < 0) { errors.push({ line, reason: "Fees cannot be negative" }); return; }

    let quantity = 0, price = 0, amount = 0;
    if (NEEDS_QTY_PRICE.includes(type)) {
      const q = parseNum(row[map.quantity]);
      const p = parseNum(row[map.price]);
      if (q === null || !(q > 0)) { errors.push({ line, reason: `${type} needs a positive quantity` }); return; }
      if (p === null || !(p > 0)) { errors.push({ line, reason: `${type} needs a positive price` }); return; }
      quantity = q; price = p; amount = q * p;
    } else {
      const a = parseNum(row[map.amount]);
      if (a === null || !(a > 0)) { errors.push({ line, reason: `${type} needs a positive amount` }); return; }
      amount = a;
    }

    valid.push({
      account_id: accountId, tickerRaw: NEEDS_SECURITY.includes(type) ? ticker : "",
      security_id: null, type, date, quantity, price, amount, fees, note: "CSV import",
    });
  });

  return { valid, errors };
}
