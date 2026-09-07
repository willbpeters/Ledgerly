import { useState } from "react";
import Papa from "papaparse";
import { useAccounts } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import { rowsToTransactions, type ColumnMap, type StagedTxn, type RowError } from "./csvImport";
import { money } from "../../ui/format";

const FIELDS: (keyof ColumnMap)[] = ["date","type","ticker","quantity","price","amount","fees"];

export function CsvImport() {
  const { data: accounts = [] } = useAccounts();
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number | "">("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<ColumnMap>({ date:"",type:"",ticker:"",quantity:"",price:"",amount:"",fees:"" });
  const [preview, setPreview] = useState<{ valid: StagedTxn[]; errors: RowError[] } | null>(null);
  const [done, setDone] = useState("");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        setHeaders(res.meta.fields ?? []);
        setRows(res.data);
        setPreview(null); setDone("");
      },
    });
  }

  function buildPreview() {
    if (!accountId) return;
    setPreview(rowsToTransactions(rows, map, Number(accountId)));
  }

  async function commit() {
    if (!preview) return;
    // resolve tickers → security ids
    const resolved = [];
    for (const t of preview.valid) {
      let security_id = t.security_id;
      if (t.tickerRaw) {
        const sec = await api.securities.getOrCreate(t.tickerRaw, null, "stock");
        security_id = sec.id;
      }
      resolved.push({ account_id: t.account_id, security_id, type: t.type, date: t.date,
        quantity: t.quantity, price: t.price, amount: t.amount, fees: t.fees, note: t.note });
    }
    const n = await api.transactions.createMany(resolved);
    await qc.invalidateQueries({ queryKey: keys.transactions });
    await qc.invalidateQueries({ queryKey: keys.securities });
    setDone(`Imported ${n} transactions.`);
    setPreview(null); setRows([]); setHeaders([]);
  }

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row">
        <label>Into account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select…</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>CSV file<input type="file" accept=".csv" onChange={onFile} /></label>
      </div>

      {headers.length > 0 && (
        <div className="row">
          {FIELDS.map((f) => (
            <label key={f}>{f}
              <select value={map[f]} onChange={(e) => setMap({ ...map, [f]: e.target.value })}>
                <option value="">—</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          ))}
          <button onClick={buildPreview} disabled={!accountId || !map.date || !map.type}>Preview</button>
        </div>
      )}

      {preview && (
        <div className="card">
          <p>{preview.valid.length} valid, <span className="neg">{preview.errors.length} skipped</span>.</p>
          {preview.errors.slice(0, 5).map((e, i) => <div key={i} className="neg">Line {e.line}: {e.reason}</div>)}
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead>
            <tbody>
              {preview.valid.slice(0, 10).map((t, i) => (
                <tr key={i}><td>{t.date}</td><td>{t.type}</td><td>{t.tickerRaw || "—"}</td>
                  <td>{t.quantity || "—"}</td><td>{t.price ? money(t.price) : "—"}</td><td>{money(t.amount)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row"><button onClick={commit} disabled={preview.valid.length === 0}>Import {preview.valid.length}</button></div>
        </div>
      )}
      {done && <p className="pos">{done}</p>}
    </div>
  );
}
