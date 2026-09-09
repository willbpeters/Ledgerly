import { useState } from "react";
import { useCreateTransactions } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import { quickAddTransactions } from "../../domain/quickAdd";
import { Button, Field } from "../../ui/components";

export function AddPositionForm({ accountId }: { accountId: number }) {
  const createTxns = useCreateTransactions();
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
      // A deposit and the buy, written together, so cash never dips negative.
      await createTxns.mutateAsync(quickAddTransactions({
        accountId, securityId: sec.id, date, shares: qty, pricePerShare: price,
      }));
      setTicker(""); setShares(""); setAvgCost("");
    } catch (err) {
      setError(`Could not add position: ${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="row" onSubmit={submit}>
      <Field label="Ticker"><input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="VOO" /></Field>
      <Field label="Type">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="stock">Stock</option><option value="etf">ETF</option>
        </select>
      </Field>
      <Field label="Shares"><input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" /></Field>
      <Field label="Avg cost"><input value={avgCost} onChange={(e) => setAvgCost(e.target.value)} inputMode="decimal" /></Field>
      <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add position"}</Button>
      {error && <span className="neg">{error}</span>}
      <p className="muted" style={{ flexBasis: "100%", margin: "4px 0 0" }}>
        Quick add assumes you already own these shares, so it records a matching
        deposit alongside the buy and leaves your cash balance unchanged.
      </p>
    </form>
  );
}
