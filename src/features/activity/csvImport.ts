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

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[$,]/g, "").trim()); return isNaN(n) ? 0 : n; };

export function rowsToTransactions(
  rows: Record<string, string>[],
  map: ColumnMap,
  accountId: number,
): { valid: StagedTxn[]; errors: RowError[] } {
  const valid: StagedTxn[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    const line = i + 1;
    const date = (row[map.date] ?? "").trim();
    const rawType = (row[map.type] ?? "").trim().toLowerCase();
    const ticker = (row[map.ticker] ?? "").trim().toUpperCase();

    if (!date) { errors.push({ line, reason: "Missing date" }); return; }
    if (!TYPES.includes(rawType as TxnType)) { errors.push({ line, reason: `Unknown type "${rawType}"` }); return; }
    const type = rawType as TxnType;
    if (NEEDS_SECURITY.includes(type) && !ticker) { errors.push({ line, reason: `Type "${type}" needs a ticker` }); return; }

    const quantity = num(row[map.quantity]);
    const price = num(row[map.price]);
    const fees = num(row[map.fees]);
    let amount = num(row[map.amount]);
    if (NEEDS_QTY_PRICE.includes(type)) amount = quantity * price;

    valid.push({
      account_id: accountId, tickerRaw: NEEDS_SECURITY.includes(type) ? ticker : "",
      security_id: null, type, date, quantity, price, amount, fees, note: "CSV import",
    });
  });

  return { valid, errors };
}
