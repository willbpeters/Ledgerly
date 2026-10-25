import { useState } from "react";
import { Button } from "../../ui/components";

/** SimpleFIN's account dashboard, where banks are added. Signed out, it sends
 *  you to the sign-in page first. (`bridge.simplefin.org` redirects here.) */
export const SIMPLEFIN_MY_ACCOUNT_URL = "https://beta-bridge.simplefin.org/my-account";

export interface AddBankSectionProps {
  onOpenSimplefin: () => void;
  onUpdateConnection: (token: string) => void;
  updating: boolean;
}

/** Adding a bank happens on SimpleFIN's site, not in Tally. This walks the
 *  owner there and back, and offers a way to hand Tally a fresh token when
 *  the existing connection does not pick the new bank up, so they never have
 *  to disconnect and start over. */
export function AddBankSection({ onOpenSimplefin, onUpdateConnection, updating }: AddBankSectionProps) {
  const [token, setToken] = useState("");
  const trimmed = token.trim();

  return (
    <details>
      <summary className="muted" style={{ cursor: "pointer" }}>Add another bank or brokerage</summary>
      <div className="grid" style={{ gap: 12, paddingTop: 10 }}>
        <ol className="steps">
          <li>
            <Button variant="secondary" size="sm" onClick={onOpenSimplefin}>Open SimpleFIN</Button>
            {" "}and sign in if it asks.
          </li>
          <li>Under <strong>Financial Institutions</strong>, click <strong>New Connection</strong> and add the bank.</li>
          <li>Come back here and click <strong>Sync now</strong>. The new accounts appear on their own.</li>
        </ol>

        <div className="grid" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Still not showing up? On the same SimpleFIN page, under <strong>Apps</strong>, make a new setup
            token and paste it here. Your existing accounts are kept and matched up, nothing is duplicated.
            Tally backs up your data first, so you can restore it from Backups if anything looks wrong.
          </div>
          <label>
            New setup token
            <textarea rows={2} value={token} onChange={(e) => setToken(e.target.value)}
              placeholder="Paste a new SimpleFIN setup token" spellCheck={false} />
          </label>
          <div>
            <Button variant="secondary" size="sm" loading={updating} disabled={!trimmed}
              onClick={() => onUpdateConnection(trimmed)}>
              Update connection
            </Button>
          </div>
        </div>
      </div>
    </details>
  );
}
