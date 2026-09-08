import { useAccounts, useDeleteAccount } from "../../data/queries";
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

  const columns: Column<Account>[] = [
    { key: "name", label: "Account", align: "left", render: (a) => (
        <div><div className="cell-primary">{a.name}</div><div className="cell-secondary">{a.institution ?? "—"}</div></div>) },
    { key: "type", label: "Type", align: "left", render: (a) => <Badge>{a.type === "brokerage" ? "Brokerage" : "Cash"}</Badge> },
    { key: "source", label: "Source", align: "left", render: (a) =>
        a.source === "simplefin" ? <Badge tone="accent">SimpleFIN</Badge> : <Badge>Manual</Badge> },
    { key: "synced", label: "Last synced", render: (a) => a.source === "simplefin" ? timeAgo(a.last_synced_at) : "—" },
    { key: "value", label: "Value", render: (a) => <span className="cell-primary">{money(accountValues.get(a.id) ?? 0)}</span> },
    { key: "actions", label: "", render: (a) => (
        <Button variant="ghost" size="sm" onClick={() => {
          const extra = a.source === "simplefin" ? " It will come back on the next SimpleFIN sync unless you disconnect in Settings." : "";
          if (confirm(`Delete "${a.name}"? This removes its transactions.${extra}`)) del.mutate(a.id);
        }}>Delete</Button>) },
  ];

  return (
    <>
      <PageHeader title="Accounts" subtitle="Where your money lives" />
      <Card title="Add an account"><AccountForm /></Card>
      <Card title="All accounts">
        {isLoading ? <p className="muted">Loading…</p> : accounts.length === 0
          ? <EmptyState title="No accounts yet" body="Add one above, or connect SimpleFIN in Settings to import them automatically." />
          : <DataTable columns={columns} rows={accounts} getKey={(a) => a.id} />}
      </Card>
    </>
  );
}
