import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { Category } from "../../domain/types";

const categories: Category[] = [
  { id: 1, name: "Groceries", kind: "spending", colour: "chart-3", sort: 10, is_builtin: true },
  { id: 2, name: "Dining", kind: "spending", colour: "cat-11", sort: 20, is_builtin: false },
];
const create = vi.hoisted(() => vi.fn());

vi.mock("../../data/queries", () => ({
  useCategories: () => ({ data: categories }),
  useRules: () => ({ data: [] }),
  useCreateCategory: () => ({ mutate: create, isPending: false }),
  useUpdateCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn() }),
  useDeleteRule: () => ({ mutate: vi.fn() }),
}));

const { CategoriesCard } = await import("./CategoriesCard");
const twelve = Array.from({ length: 12 }, (_, i) => `cat-${i + 1}`);
const pillOf = (el: HTMLElement) => el.closest(".cat-pill") as HTMLElement;

describe("CategoriesCard", () => {
  it("lists each category as a pill in its colour", () => {
    render(<CategoriesCard />);
    expect(pillOf(screen.getByText("Groceries")).style.getPropertyValue("--pill")).toBe("var(--cat-3)");
    expect(pillOf(screen.getByText("Dining")).style.getPropertyValue("--pill")).toBe("var(--cat-11)");
  });

  it("offers all twelve colours for a new category, after letting Tally choose", () => {
    render(<CategoriesCard />);
    const picker = screen.getByLabelText("New colour");
    expect(picker).toHaveValue("auto");
    const options = within(picker).getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["auto", ...twelve]);
  });

  it("lets Tally choose a new category's colour unless one is picked", () => {
    create.mockClear();
    render(<CategoriesCard />);
    fireEvent.change(screen.getByLabelText("New category name"), { target: { value: "Pets" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(create).toHaveBeenCalledWith({ name: "Pets", kind: "spending", colour: "auto" }, expect.anything());
  });

  it("adds a category in the colour chosen", () => {
    create.mockClear();
    render(<CategoriesCard />);
    fireEvent.change(screen.getByLabelText("New colour"), { target: { value: "cat-12" } });
    fireEvent.change(screen.getByLabelText("New category name"), { target: { value: "Pets" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(create).toHaveBeenCalledWith({ name: "Pets", kind: "spending", colour: "cat-12" }, expect.anything());
  });

  it("offers all twelve colours when editing, starting from the category's own", () => {
    render(<CategoriesCard />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const picker = screen.getByLabelText("Colour");
    expect(picker).toHaveValue("cat-3");
    expect(within(picker).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(twelve);
  });
});
