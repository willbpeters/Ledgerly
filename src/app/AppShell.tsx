import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main"><Outlet /></main>
    </div>
  );
}
