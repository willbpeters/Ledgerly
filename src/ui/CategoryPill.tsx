import type { CSSProperties } from "react";
import { categoryColour } from "./categoryColour";
import type { Category } from "../domain/types";

/** The pill's colour, as the `--pill` variable its styles in `styles.css` read. */
function pillStyle(category: Category | null | undefined): CSSProperties | undefined {
  return category ? ({ "--pill": categoryColour(category.colour) } as CSSProperties) : undefined;
}

/**
 * A category as a tinted pill: its colour faintly behind its name, the name
 * in a deeper shade of the same colour. No category is a dashed, muted
 * "Uncategorised" outline, so it reads as something still to do.
 */
export function CategoryPill({ category }: { category: Category | null | undefined }) {
  return (
    <span className={`cat-pill${category ? "" : " none"}`} style={pillStyle(category)}>
      {category && <span className="cat-pill-dot" aria-hidden="true" />}
      <span className="cat-pill-name">{category?.name ?? "Uncategorised"}</span>
    </span>
  );
}

/**
 * A category picker that looks like a `CategoryPill`. It is a native select
 * underneath, so the keyboard and screen readers treat it as one.
 */
export function CategorySelect({ categories, value, onChange, "aria-label": label }: {
  categories: Category[];
  value: number | null;
  onChange: (categoryId: number | null) => void;
  "aria-label": string;
}) {
  const category = value == null ? null : categories.find((c) => c.id === value) ?? null;
  return (
    <span className={`cat-pill cat-select${category ? "" : " none"}`} style={pillStyle(category)}>
      {category && <span className="cat-pill-dot" aria-hidden="true" />}
      <select value={value ?? ""} aria-label={label}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">Uncategorised</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <svg className="cat-select-chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.4"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
