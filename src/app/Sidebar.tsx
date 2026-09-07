import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/holdings", label: "Holdings" },
  { to: "/accounts", label: "Accounts" },
  { to: "/activity", label: "Activity" },
];

export function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="brand">◆ MyFinance</div>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}
          className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
          {l.label}
        </NavLink>
      ))}
      <span className="navlink disabled">Budget · soon</span>
      <div style={{ flex: 1 }} />
      <NavLink to="/settings" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
        Settings
      </NavLink>
    </nav>
  );
}
