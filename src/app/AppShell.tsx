import { useState } from "react";
import { Outlet } from "react-router-dom";
import { IconRail } from "./IconRail";
import { CommandBar } from "./CommandBar";
import { InsightRail } from "./InsightRail";

const KEY = "ledgerly.insightRail";

function loadOpen(): boolean {
  try { return localStorage.getItem(KEY) !== "closed"; } catch { return true; }
}

export function AppShell() {
  const [open, setOpen] = useState(loadOpen);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? "open" : "closed"); } catch { /* storage unavailable */ }
      return next;
    });
  }

  return (
    <div className="layout">
      <IconRail />
      <div className="centre">
        <CommandBar onToggleInsight={toggle} />
        <main className="workspace"><div className="page"><Outlet /></div></main>
      </div>
      {open && <InsightRail />}
    </div>
  );
}
