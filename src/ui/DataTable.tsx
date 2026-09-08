import type { ReactNode } from "react";

export interface Column<R> {
  key: string;
  label: ReactNode;
  align?: "left" | "right";
  render: (row: R) => ReactNode;
  className?: (row: R) => string | undefined;
}

export function DataTable<R>({ columns, rows, getKey }:
  { columns: Column<R>[]; rows: R[]; getKey: (row: R) => string | number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.align === "left" ? "left" : ""}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={getKey(r)}>
              {columns.map((c) => (
                <td key={c.key} className={[c.align === "left" ? "left" : "", c.className?.(r) ?? ""].filter(Boolean).join(" ")}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
