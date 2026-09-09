import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  useTransactions, useSecurities, useAccounts, useDeleteTransaction,
  useBankTransactions, useBankTransactionRange, useCategories,
} from "../../data/queries";
import { AddPositionForm } from "./AddPositionForm";
import { TransactionForm } from "./TransactionForm";
import { CsvImport } from "./CsvImportForm";
import { money, fmtDate } from "../../ui/format";
import { PageHeader, Card, Button, Badge, Tabs, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import type { BankTransaction, Transaction } from "../../domain/types";

type Tab = "position" | "transaction" | "csv";
const TXN_TONE: Record<string, "pos" | "neg" | "neutral" | "accent" | "warn"> = {
  buy: "accent", sell: "warn", dividend: "pos", interest: "pos", deposit: "pos", withdrawal: "neg", fee: "neg",
};

export function Activity() {
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const del = useDeleteTransaction();
  const [tab, setTab] = useState<Tab>("position");
  const [accountId, setAccountId] = useState<number | null>(null);

  // Bank and card rows live in a different table from investment transactions,
  // written by SimpleFIN sync. Ask for everything held; SimpleFIN keeps at most
  // 90 days, so the window is small either way.
  const { data: range } = useBankTransactionRange();
  const { data: bankTxns = [] } = useBankTransactions(range?.[0] ?? "1900-01-01", range?.[1] ?? "2999-12-31");

  useEffect(() => {
    if (accounts.length === 0) { setAccountId(null); return; }
    if (accountId == null || !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const secTicker = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? "—";
  const categoryName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? "Uncategorised";
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const synced = account?.source === "simplefin";
  const accountTxns = accountId == null ? [] : txns.filter((t) => t.account_id === accountId);
  const accountBankTxns = accountId == null ? [] : bankTxns.filter((t) => t.account_id === accountId);

  const columns: Column<Transaction>[] = [
    { key: "date", label: "Date", align: "left", render: (t) => fmtDate(t.date) },
    { key: "type", label: "Type", align: "left", render: (t) => <Badge tone={TXN_TONE[t.type] ?? "neutral"}>{t.type}</Badge> },
    { key: "ticker", label: "Ticker", align: "left", render: (t) => <span className="cell-primary">{secTicker(t.security_id)}</span> },
    { key: "qty", label: "Qty", render: (t) => t.quantity || "—" },
    { key: "price", label: "Price", render: (t) => (t.price ? money(t.price) : "—") },
    { key: "amount", label: "Amount", render: (t) => money(t.amount) },
    { key: "actions", label: "", render: (t) => (
        <Button variant="ghost" size="sm" onClick={() => {
          if (confirm("Delete this transaction? Holdings and balances will recompute.")) del.mutate(t.id);
        }}>Delete</Button>) },
  ];

  // Synced rows are read-only here: they belong to the bank, and their category
  // is changed in Spending, where the rules that follow from it also live.
  const bankColumns: Column<BankTransaction>[] = [
    { key: "date", label: "Date", align: "left", render: (t) => fmtDate(t.posted) },
    { key: "description", label: "Description", align: "left", render: (t) => (
        <div>
          <div className="cell-primary">{t.description}</div>
          {t.pending && <div className="cell-secondary">Pending</div>}
        </div>) },
    { key: "category", label: "Category", align: "left", render: (t) => <Badge>{categoryName(t.category_id)}</Badge> },
    { key: "amount", label: "Amount", render: (t) => (
        <span className={t.amount < 0 ? "neg" : "pos"}>{money(t.amount)}</span>) },
  ];

  if (accounts.length === 0) {
    return (
      <>
        <Card><EmptyState title="You need an account first"
          body={<>Create one in <Link to="/accounts">Accounts</Link>, then come back here.</>} /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader subtitle="Record trades, cash moves, or import a CSV"
        actions={
          <select value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.source === "simplefin" ? " (synced)" : ""}</option>)}
          </select>
        } />

      {synced ? (
        <Card>
          <div className="notice info">
            This account is synced from SimpleFIN, so manual entries are turned off.
            Its transactions are below — to change how one is categorised, use <Link to="/spending">Spending</Link>.
          </div>
        </Card>
      ) : accountId != null && (
        <Card>
          <Tabs<Tab> value={tab} onChange={setTab} items={[
            { value: "position", label: "Quick add position" },
            { value: "transaction", label: "Add transaction" },
            { value: "csv", label: "Import CSV" },
          ]} />
          {tab === "position" ? <AddPositionForm accountId={accountId} />
            : tab === "transaction" ? <TransactionForm accountId={accountId} />
            : <CsvImport accountId={accountId} />}
        </Card>
      )}

      <Card title="Transactions" subtitle={account?.name}>
        {synced
          ? (accountBankTxns.length === 0
              ? <EmptyState title="No transactions have synced for this account yet"
                  body="SimpleFIN refreshes about once a day, and transactions often take a few days to appear after you spend." />
              : <DataTable columns={bankColumns} rows={accountBankTxns} getKey={(t) => t.id} />)
          : (accountTxns.length === 0
              ? <EmptyState title="No transactions in this account yet" />
              : <DataTable columns={columns} rows={accountTxns} getKey={(t) => t.id} />)}
      </Card>
    </>
  );
}
