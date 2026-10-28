import { useState, type ReactNode } from "react";

/** Account ids the owner has closed on Holdings, so they stay closed next time. */
export const COLLAPSED_KEY = "ledgerly.holdings.collapsed.v1";

function loadCollapsed(): number[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function saveCollapsed(id: number, collapsed: boolean) {
  // Read fresh rather than from state: each card keeps its own state, and a
  // stale list would put back an account another card has just opened.
  const ids = new Set(loadCollapsed());
  if (collapsed) ids.add(id);
  else ids.delete(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}

/**
 * One account's holdings on the Holdings page, opened and closed from its
 * header. The summary line stays visible when closed, so a closed account
 * still says what it holds.
 */
export function AccountHoldingsCard({ accountId, title, subtitle, children }:
  { accountId: number; title: string; subtitle: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => !loadCollapsed().includes(accountId));

  function toggle() {
    saveCollapsed(accountId, open);
    setOpen(!open);
  }

  return (
    <section className="card">
      <button className={`card-head collapse-head${open ? "" : " closed"}`} aria-expanded={open} onClick={toggle}>
        <div>
          <div className="card-title">{title}</div>
          <div className="card-subtitle">{subtitle}</div>
        </div>
        <span className="collapse-chevron" aria-hidden="true">▾</span>
      </button>
      {open && children}
    </section>
  );
}
