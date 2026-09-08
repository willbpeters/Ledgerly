import { NavLink } from "react-router-dom";
import { Icons } from "./icons";
import { ThemeToggle } from "../ui/ThemeToggle";

const links = [
  { to: "/", label: "Dashboard", end: true, icon: Icons.dashboard },
  { to: "/holdings", label: "Holdings", icon: Icons.holdings },
  { to: "/accounts", label: "Accounts", icon: Icons.accounts },
  { to: "/activity", label: "Activity", icon: Icons.activity },
];

const cls = ({ isActive }: { isActive: boolean }) => "navlink" + (isActive ? " active" : "");

export function Sidebar({ footer }: { footer?: React.ReactNode }) {
  return (
    <nav className="sidebar">
      <div className="brand"><span className="brand-mark">◆</span>Ledgerly</div>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end} className={cls}>
          <l.icon />{l.label}
        </NavLink>
      ))}
      <span className="navlink disabled"><Icons.budget />Budget<span className="nav-tag">soon</span></span>
      <NavLink to="/settings" className={cls}><Icons.settings />Settings</NavLink>
      <div className="sidebar-footer">
        {footer}
        <ThemeToggle />
      </div>
    </nav>
  );
}
