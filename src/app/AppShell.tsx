import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { SyncButton } from "./SyncButton";

export function AppShell() {
  return (
    <div className="layout">
      <Sidebar footer={<SyncButton />} />
      <main className="main"><div className="page"><Outlet /></div></main>
    </div>
  );
}
