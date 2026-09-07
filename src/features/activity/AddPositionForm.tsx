import { useState } from "react";
import { useAccounts, useCreateTransaction } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";

export function AddPositionForm() {
  const { data: accounts = [] } = useAccounts();
  const createTxn = useCreateTransaction();
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number | "">("");
  const [ticker, setTicker] = useState("");
  const [kind, setKind] = useState("stock");
  const [shares, setShares] = useState("");
  const [avgCost, setAvgCost] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const acct = Number(accountId), qty = Number(shares), price = Number(avgCost);
    if (!acct || !ticker.trim() || !(qty > 0) || !(price >= 0)) {
      setError("Fill account, ticker, positive shares, and cost."); return;
    }
    const sec = await api.securities.getOrCreate(ticker.trim(), null, kind);
    await qc.invalidateQueries({ queryKey: keys.securities });
    createTxn.mutate(
      { account_id: acct, security_id: sec.id, type: "buy", date,
        quantity: qty, price, amount: qty * price, fees: 0, note: "Quick add" },
      { onSuccess: () => { setTicker(""); setShares(""); setAvgCost(""); } },
    );
  }

  return (
    <form className="row" onSubmit={submit}>
      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Ticker<input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="VOO" /></label>
      <label>Type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="stock">Stock</option><option value="etf">ETF</option>
        </select>
      </label>
      <label>Shares<input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" /></label>
      <label>Avg cost<input value={avgCost} onChange={(e) => setAvgCost(e.target.value)} inputMode="decimal" /></label>
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="submit">Add position</button>
      {error && <span className="neg">{error}</span>}
    </form>
  );
}
