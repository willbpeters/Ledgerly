import { useState } from "react";
import { useCreateTransaction } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";

export function AddPositionForm({ accountId }: { accountId: number }) {
  const createTxn = useCreateTransaction();
  const qc = useQueryClient();
  const [ticker, setTicker] = useState("");
  const [kind, setKind] = useState("stock");
  const [shares, setShares] = useState("");
  const [avgCost, setAvgCost] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const qty = Number(shares), price = Number(avgCost);
    if (!ticker.trim() || !(qty > 0) || !(price >= 0)) {
      setError("Fill ticker, positive shares, and cost."); return;
    }
    setBusy(true);
    try {
      const sec = await api.securities.getOrCreate(ticker.trim(), null, kind);
      await qc.invalidateQueries({ queryKey: keys.securities });
      await createTxn.mutateAsync(
        { account_id: accountId, security_id: sec.id, type: "buy", date,
          quantity: qty, price, amount: qty * price, fees: 0, note: "Quick add" },
      );
      setTicker(""); setShares(""); setAvgCost("");
    } catch (err) {
      setError(`Could not add position: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="row" onSubmit={submit}>
      <label>Ticker<input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="VOO" /></label>
      <label>Type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="stock">Stock</option><option value="etf">ETF</option>
        </select>
      </label>
      <label>Shares<input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" /></label>
      <label>Avg cost<input value={avgCost} onChange={(e) => setAvgCost(e.target.value)} inputMode="decimal" /></label>
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "Adding…" : "Add position"}</button>
      {error && <span className="neg">{error}</span>}
    </form>
  );
}
