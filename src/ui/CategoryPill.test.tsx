import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CategoryPill, CategorySelect } from "./CategoryPill";
import type { Category } from "../domain/types";

const groceries: Category = { id: 1, name: "Groceries", kind: "spending", colour: "cat-11", sort: 10, is_builtin: true };
const dining: Category = { id: 2, name: "Dining", kind: "spending", colour: "chart-3", sort: 20, is_builtin: true };

const pillOf = (el: HTMLElement) => el.closest(".cat-pill") as HTMLElement;

describe("CategoryPill", () => {
  it("shows the category's name in its own colour", () => {
    render(<CategoryPill category={groceries} />);
    const pill = pillOf(screen.getByText("Groceries"));
    expect(pill).not.toBeNull();
    expect(pill.style.getPropertyValue("--pill")).toBe("var(--cat-11)");
    expect(pill).not.toHaveClass("none");
  });

  it("colours a category saved with an older chart token", () => {
    render(<CategoryPill category={dining} />);
    expect(pillOf(screen.getByText("Dining")).style.getPropertyValue("--pill")).toBe("var(--cat-3)");
  });

  it("shows no category as a muted Uncategorised outline", () => {
    render(<CategoryPill category={null} />);
    const pill = pillOf(screen.getByText("Uncategorised"));
    expect(pill).toHaveClass("none");
    expect(pill.style.getPropertyValue("--pill")).toBe("");
  });
});

describe("CategorySelect", () => {
  const renderSelect = (value: number | null, onChange = vi.fn()) => {
    render(<CategorySelect categories={[groceries, dining]} value={value} onChange={onChange}
      aria-label="Category for Target" />);
    return onChange;
  };

  it("is a select that takes its label and shows the chosen category", () => {
    renderSelect(2);
    const select = screen.getByRole("combobox", { name: "Category for Target" });
    expect(select).toHaveValue("2");
    expect(pillOf(select).style.getPropertyValue("--pill")).toBe("var(--cat-3)");
  });

  it("offers Uncategorised and every category", () => {
    renderSelect(null);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Uncategorised", "Groceries", "Dining"]);
    expect(pillOf(screen.getByRole("combobox"))).toHaveClass("none");
  });

  it("hands back the chosen category's id", () => {
    const onChange = renderSelect(null);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("hands back null for Uncategorised", () => {
    const onChange = renderSelect(1);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
