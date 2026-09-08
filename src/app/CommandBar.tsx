import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSimplefinStatus, useSimplefinSync } from "../data/queries";
import { useToast } from "../ui/toast";
import { timeAgo } from "../ui/format";
import { Button } from "../ui/components";
import { Icons } from "./icons";

const TITLES: { path: string; title: string }[] = [
  { path: "/holdings", title: "Holdings" },
  { path: "/accounts", title: "Accounts" },
  { path: "/activity", title: "Activity" },
  { path: "/settings", title: "Settings" },
];

function titleFor(pathname: string): string {
  return TITLES.find((t) => pathname.startsWith(t.path))?.title ?? "Dashboard";
}

export function CommandBar({ onToggleInsight }: { onToggleInsight: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: status } = useSimplefinStatus();
  const sync = useSimplefinSync();
  const toast = useToast();
  const [term, setTerm] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Ctrl+K (Cmd+K on a Mac keyboard) puts the cursor in the search box.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (!q) return;
    navigate(`/holdings?q=${encodeURIComponent(q)}`);
    input.current?.blur();
  }

  function runSync() {
    sync.mutate(undefined, {
      onSuccess: (r) => toast.push({
        tone: r.errors.length ? "neutral" : "pos",
        title: `Synced ${r.accounts_synced} account${r.accounts_synced === 1 ? "" : "s"}`,
        body: [r.holdings_synced ? `${r.holdings_synced} holdings` : "", r.errors[0] ?? ""].filter(Boolean).join(" · "),
      }),
      onError: (e) => toast.push({ tone: "neg", title: "Sync failed", body: String(e) }),
    });
  }

  return (
    <header className="cmdbar">
      <h1 className="cmd-title">{titleFor(pathname)}</h1>
      <form className="cmd-search" onSubmit={submit}>
        <Icons.search size={14} />
        <input ref={input} value={term} onChange={(e) => setTerm(e.target.value)}
          placeholder="Search a ticker or account" aria-label="Search" />
        <span className="kbd">Ctrl K</span>
      </form>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
        {status?.connected && (
          <>
            <span className="cmd-status"><span className="dot" />Synced {timeAgo(status.last_synced_at)}</span>
            <Button variant="secondary" size="sm" loading={sync.isPending} onClick={runSync}>
              <Icons.sync size={13} />Sync
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={onToggleInsight} title="Show or hide the side panel" aria-label="Toggle side panel">
          <Icons.panel size={15} />
        </Button>
      </div>
    </header>
  );
}
