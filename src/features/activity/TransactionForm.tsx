import { useState } from "react";
import { useAccounts, useSecurities, useCreateTransaction } from "../../data/queries";
import { api, type NewTransaction } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import type { TxnType } from "../../domain/types";

const NEEDS_SECURITY: TxnType[] = ["buy", "sell", "dividend"];
const NEEDS_QTY_PRICE: TxnType[] = ["buy", "sell"];

export function TransactionForm() {
  const { data: accounts = [] } = useAccounts();
  const { data: securities = [] } = useSecurities();
  const createTxn = useCreateTransaction();
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState<number | "">("");
  const [type, setType] = useState<TxnType>("buy");
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [fees, setFees] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const acct = Number(accountId);
    if (!acct) { setError("Pick an account."); return; }

    let security_id: number | null = null;
    if (NEEDS_SECURITY.includes(type)) {
      if (!ticker.trim()) { setError("This type needs a ticker."); return; }
      const sec = await api.securities.getOrCreate(ticker.trim(), null, "stock");
      await qc.invalidateQueries({ queryKey: keys.securities });
      security_id = sec.id;
    }
    const qty = Number(quantity) || 0, pr = Number(price) || 0, fee = Number(fees) || 0;
    let amt = Number(amount) || 0;
    if (NEEDS_QTY_PRICE.includes(type)) amt = qty * pr;

    const txn: NewTransaction = {
      account_id: acct, security_id, type, date,
      quantity: qty, price: pr, amount: amt, fees: fee, note: null,
    };
    createTxn.mutate(txn, { onSuccess: () => { setQuantity(""); setPrice(""); setAmount(""); setFees(""); } });
  }

  const showSec = NEEDS_SECURITY.includes(type);
  const showQtyPrice = NEEDS_QTY_PRICE.includes(type);

  return (
    <form className="row" onSubmit={submit}>
      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value as TxnType)}>
          {["buy","sell","dividend","deposit","withdrawal","fee","interest"].map((t) =>
            <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      {showSec && (
        <label>Ticker
          <input list="sec-list" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} />
          <datalist id="sec-list">{securities.map((s) => <option key={s.id} value={s.ticker} />)}</datalist>
        </label>
      )}
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {showQtyPrice ? (
        <>
          <label>Quantity<input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" /></label>
          <label>Price<input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
          <label>Fees<input value={fees} onChange={(e) => setFees(e.target.value)} inputMode="decimal" /></label>
        </>
      ) : (
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
      )}
      <button type="submit">Add</button>
      {error && <span className="neg">{error}</span>}
    </form>
  );
}
