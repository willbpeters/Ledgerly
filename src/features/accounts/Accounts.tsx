import { useState } from "react";
import { useAccounts, useDeleteAccount, useSetAccountType, useSetAccountHidden } from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { AccountForm } from "./AccountForm";
import { PageHeader, Card, Button, Badge, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import { money, timeAgo } from "../../ui/format";
import type { Account } from "../../domain/types";

export function Accounts() {
  const { data: accounts = [], isLoading } = useAccounts();
  const { accountValues } = usePortfolio();
  const del = useDeleteAccount();
  const setType = useSetAccountType();
  const setHidden = useSetAccountHidden();
  const [showHidden, setShowHidden] = useState(false);

  // This is the one screen that sees hidden accounts: everywhere else they are
  // filtered out in derivePortfolio, which is why accountValues has no entry
  // for them and their Value column reads as nothing.
  const hiddenCount = accounts.filter((a) => a.hidden).length;
  const rows = showHidden ? accounts : accounts.filter((a) => !a.hidden);
  const dim = (a: Account) => (a.hidden ? "dim" : undefined);

  const columns: Column<Account>[] = [
    { key: "name", label: "Account", align: "left", className: dim, render: (a) => (
        <div>
          <div className="cell-primary">
            {a.name}{a.hidden && <> <Badge>Hidden</Badge></>}
          </div>
          <div className="cell-secondary">{a.institution ?? "—"}</div>
        </div>) },
    // SimpleFIN never says what kind of account something is, so it is a guess
    // from the balance sign and can be corrected here.
    { key: "type", label: "Type", align: "left", className: dim, render: (a) => (
        <select value={a.type} aria-label={`Type of ${a.name}`}
          onChange={(e) => setType.mutate({ id: a.id, kind: e.target.value })}
          style={{ padding: "3px 6px", fontSize: 12 }}>
          <option value="brokerage">Brokerage</option>
          <option value="cash">Cash</option>
          <option value="credit">Credit card</option>
        </select>) },
    { key: "source", label: "Source", align: "left", className: dim, render: (a) =>
        a.source === "simplefin" ? <Badge tone="accent">SimpleFIN</Badge> : <Badge>Manual</Badge> },
    { key: "synced", label: "Last synced", className: dim, render: (a) => a.source === "simplefin" ? timeAgo(a.last_synced_at) : "—" },
    { key: "value", label: "Value", className: dim, render: (a) => (
        <span className="cell-primary">{a.hidden ? "—" : money(accountValues.get(a.id) ?? 0)}</span>) },
    { key: "actions", label: "", render: (a) => (
        <div className="row center" style={{ gap: 4, justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm"
            onClick={() => setHidden.mutate({ id: a.id, hidden: !a.hidden })}>
            {a.hidden ? "Unhide" : "Hide"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => {
            const extra = a.source === "simplefin" ? " It will come back on the next SimpleFIN sync unless you disconnect in Settings." : "";
            if (confirm(`Delete "${a.name}"? This removes its transactions.${extra}`)) del.mutate(a.id);
          }}>Delete</Button>
        </div>) },
  ];

  return (
    <>
      <PageHeader subtitle="Where your money lives" />
      <Card title="Add an account"><AccountForm /></Card>
      <Card
        title="All accounts"
        subtitle={hiddenCount > 0 ? "Hidden accounts are left out of your net worth and every chart." : undefined}
        actions={hiddenCount > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setShowHidden((s) => !s)}>
            {showHidden ? `Hide hidden (${hiddenCount})` : `Show hidden (${hiddenCount})`}
          </Button>
        )}>
        {isLoading ? <p className="muted">Loading…</p> : accounts.length === 0
          ? <EmptyState title="No accounts yet" body="Add one above, or connect SimpleFIN in Settings to import them automatically." />
          : <DataTable columns={columns} rows={rows} getKey={(a) => a.id} />}
      </Card>
    </>
  );
}
