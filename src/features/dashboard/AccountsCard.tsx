import { Link } from "react-router-dom";
import { money } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { AccountGroup } from "../../domain/overview";

/** Every visible account by type, with each type's total. */
export function AccountsCard({ groups }: { groups: AccountGroup[] }) {
  return (
    <Card title="Accounts" actions={<Link to="/accounts" style={{ fontSize: 11, fontWeight: 600 }}>Manage</Link>}>
      {groups.length === 0 ? (
        <EmptyState title="No accounts yet"
          body={<>Add one in <Link to="/accounts">Accounts</Link>, or connect SimpleFIN in <Link to="/settings">Settings</Link>.</>} />
      ) : groups.map((g) => (
        <div key={g.type} className="acct-group">
          <div className="acct-group-head">
            <span className="cap">{g.label}</span>
            <span className={`n muted${g.total < 0 ? " neg" : ""}`}>{money(g.total)}</span>
          </div>
          {g.accounts.map(({ account, value }) => (
            <div key={account.id} className="acct-row">
              <span>
                <span className="cell-primary">{account.name}</span>
                {account.institution && <span className="muted"> · <span>{account.institution}</span></span>}
              </span>
              <span className={`n${value < 0 ? " neg" : ""}`}>{money(value)}</span>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
