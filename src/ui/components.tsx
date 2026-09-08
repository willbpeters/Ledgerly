import type { ReactNode, ButtonHTMLAttributes } from "react";

/**
 * The row under the command bar. The screen's name lives in the command bar,
 * so this carries only the supporting line and any screen-level actions.
 */
export function PageHeader({ subtitle, actions }: { subtitle?: ReactNode; actions?: ReactNode }) {
  if (!subtitle && !actions) return null;
  return (
    <div className="row center between" style={{ gap: 16 }}>
      <div className="muted">{subtitle}</div>
      {actions && <div className="row center" style={{ gap: 8 }}>{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, style }:
  { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="card" style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-subtitle">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, delta, hint }: { label: string; value: string; delta?: number; hint?: ReactNode }) {
  const tone = delta == null ? "" : delta > 0 ? "pos" : delta < 0 ? "neg" : "";
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: "sm" | "md"; loading?: boolean; block?: boolean;
}
export function Button({ variant = "primary", size = "md", loading, block, className = "", children, disabled, ...rest }: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : "", block ? "btn-block" : "", className].filter(Boolean).join(" ");
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "pos" | "neg" | "warn"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {body && <div>{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ items, value, onChange }:
  { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={it.value === value}
          className={it.value === value ? "on" : ""} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ items, value, onChange }:
  { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {items.map((it) => (
        <button key={it.value} className={it.value === value ? "on" : ""} onClick={() => onChange(it.value)}>{it.label}</button>
      ))}
    </div>
  );
}
