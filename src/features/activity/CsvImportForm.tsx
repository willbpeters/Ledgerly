import { useState } from "react";
import Papa from "papaparse";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import { rowsToTransactions, type ColumnMap, type StagedTxn, type RowError } from "./csvImport";
import { money } from "../../ui/format";
import { Button, Field } from "../../ui/components";

const FIELDS: (keyof ColumnMap)[] = ["date","type","ticker","quantity","price","amount","fees"];
const EMPTY_MAP: ColumnMap = { date:"",type:"",ticker:"",quantity:"",price:"",amount:"",fees:"" };

export function CsvImport({ accountId }: { accountId: number }) {
  const qc = useQueryClient();
  const [newType, setNewType] = useState("stock");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<ColumnMap>(EMPTY_MAP);
  const [preview, setPreview] = useState<{ valid: StagedTxn[]; errors: RowError[] } | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        setHeaders(res.meta.fields ?? []);
        setRows(res.data);
        setMap(EMPTY_MAP); // new file: columns differ, force re-mapping
        setPreview(null); setDone(""); setError("");
        setParseWarnings((res.errors ?? []).slice(0, 5).map(
          (er) => `Row ${er.row != null ? er.row + 2 : "?"}: ${er.message}`,
        ));
      },
    });
  }

  function buildPreview() {
    setDone(""); setError("");
    setPreview(rowsToTransactions(rows, map, accountId));
  }

  async function commit() {
    if (!preview || committing) return;
    setCommitting(true);
    setError("");
    try {
      const resolved = [];
      for (const t of preview.valid) {
        let security_id = t.security_id;
        if (t.tickerRaw) {
          const sec = await api.securities.getOrCreate(t.tickerRaw, null, newType);
          security_id = sec.id;
        }
        resolved.push({ account_id: t.account_id, security_id, type: t.type, date: t.date,
          quantity: t.quantity, price: t.price, amount: t.amount, fees: t.fees, note: t.note });
      }
      const n = await api.transactions.createMany(resolved);
      await qc.invalidateQueries({ queryKey: keys.transactions });
      await qc.invalidateQueries({ queryKey: keys.securities });
      setDone(`Imported ${n} transactions.`);
      setPreview(null); setRows([]); setHeaders([]); setMap(EMPTY_MAP);
    } catch (err) {
      setError(`Import failed: ${err}. No further rows were written.`);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row">
        <Field label="New tickers as">
          <select value={newType} onChange={(e) => setNewType(e.target.value)}>
            <option value="stock">Stock</option>
            <option value="etf">ETF</option>
          </select>
        </Field>
        <Field label="CSV file"><input type="file" accept=".csv" onChange={onFile} /></Field>
      </div>

      {parseWarnings.length > 0 && (
        <div className="card">
          <p className="neg">The file had parsing problems — review your data before importing:</p>
          {parseWarnings.map((w, i) => <div key={i} className="neg">{w}</div>)}
        </div>
      )}

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
          <Button onClick={buildPreview} disabled={!map.date || !map.type}>Preview</Button>
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
          <div className="row">
            <Button onClick={commit} disabled={preview.valid.length === 0 || committing}>
              {committing ? "Importing…" : `Import ${preview.valid.length}`}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="neg">{error}</p>}
      {done && <p className="pos">{done}</p>}
    </div>
  );
}
