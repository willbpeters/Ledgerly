import { NavLink } from "react-router-dom";
import { Icons } from "./icons";

const links = [
  { to: "/", label: "Dashboard", end: true, icon: Icons.dashboard },
  { to: "/holdings", label: "Holdings", icon: Icons.holdings },
  { to: "/accounts", label: "Accounts", icon: Icons.accounts },
  { to: "/activity", label: "Activity", icon: Icons.activity },
  { to: "/spending", label: "Spending", icon: Icons.budget },
];

export function IconRail() {
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-mark" aria-hidden>◆</div>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end} title={l.label} aria-label={l.label}
          className={({ isActive }) => "rail-btn" + (isActive ? " active" : "")}>
          <l.icon />
        </NavLink>
      ))}
      <div className="rail-foot">
        <NavLink to="/settings" title="Settings" aria-label="Settings"
          className={({ isActive }) => "rail-btn" + (isActive ? " active" : "")}>
          <Icons.settings />
        </NavLink>
      </div>
    </nav>
  );
}
