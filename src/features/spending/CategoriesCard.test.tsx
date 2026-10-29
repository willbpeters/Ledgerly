import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { Category, CategoryRule } from "../../domain/types";

const categories: Category[] = [
  { id: 1, name: "Groceries", kind: "spending", colour: "chart-3", sort: 10, is_builtin: true },
  { id: 2, name: "Dining", kind: "spending", colour: "cat-11", sort: 20, is_builtin: false },
];
const create = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const clear = vi.hoisted(() => vi.fn());
const setKind = vi.hoisted(() => vi.fn());
const createRule = vi.hoisted(() => vi.fn());
const rules = vi.hoisted(() => ({ list: [] as CategoryRule[] }));
const answer = vi.hoisted(() => ({ ok: true, shown: [] as string[] }));
const listed = vi.hoisted(() => ({ empty: false }));

vi.mock("../../ui/confirm", () => ({
  askToConfirm: async (message: string) => { answer.shown.push(message); return answer.ok; },
}));
vi.mock("../../data/queries", () => ({
  useCategories: () => ({ data: listed.empty ? [] : categories }),
  useClearCategories: () => ({ mutate: clear, isPending: false }),
  useRules: () => ({ data: rules.list }),
  useSetCategoryKind: () => ({ mutate: setKind }),
  useCreateRule: () => ({ mutate: createRule, isPending: false }),
  useCreateCategory: () => ({ mutate: create, isPending: false }),
  useUpdateCategory: () => ({ mutate: update, isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn() }),
  useDeleteRule: () => ({ mutate: vi.fn() }),
}));

const { CategoriesCard } = await import("./CategoriesCard");
const twelve = Array.from({ length: 12 }, (_, i) => `cat-${i + 1}`);
const pillOf = (name: string) =>
  screen.getAllByText(name).find((el) => !el.closest("select"))!.closest(".cat-pill") as HTMLElement;

describe("CategoriesCard", () => {
  it("removes every category only after asking", async () => {
    clear.mockClear();
    answer.ok = false;
    render(<CategoriesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Remove all categories" }));
    await vi.waitFor(() => expect(answer.shown[answer.shown.length - 1]).toMatch(/Remove all 2 categories\?.*No transaction is deleted/));
    expect(clear).not.toHaveBeenCalled();

    answer.ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Remove all categories" }));
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  });

  it("with no categories, says how to get some and offers nothing to remove", () => {
    listed.empty = true;
    render(<CategoriesCard />);
    expect(screen.getByText("No categories yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove all categories" })).toBeNull();
    listed.empty = false;
  });

  it("lists each category as a pill in its colour", () => {
    render(<CategoriesCard />);
    expect(pillOf("Groceries").style.getPropertyValue("--pill")).toBe("var(--cat-3)");
    expect(pillOf("Dining").style.getPropertyValue("--pill")).toBe("var(--cat-11)");
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

  it("saves an older chart colour as its cat colour, even when the colour was not touched", () => {
    update.mockClear();
    render(<CategoriesCard />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(update).toHaveBeenCalledWith({ id: 1, name: "Groceries", colour: "cat-3" }, expect.anything());
  });

  it("says what each category counts as, and changes it", () => {
    setKind.mockClear();
    render(<CategoriesCard />);
    const groceries = screen.getByLabelText("What Groceries counts as");
    expect(groceries).toHaveValue("spending");
    expect(within(groceries).getAllByRole("option").map((o) => o.textContent)).toEqual(["Spending", "Income", "Not counted"]);
    fireEvent.change(groceries, { target: { value: "transfer" } });
    expect(setKind).toHaveBeenCalledWith({ id: 1, kind: "transfer" }, expect.anything());
  });

  it("writes a rule of the owner's own once it has text and a category", () => {
    createRule.mockClear();
    render(<CategoriesCard />);
    const add = screen.getByRole("button", { name: "Add rule" });
    fireEvent.change(screen.getByLabelText("What the rule looks at"), { target: { value: "description" } });
    fireEvent.change(screen.getByLabelText("Text to look for"), { target: { value: "PAYROLL" } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Category for the rule"), { target: { value: "2" } });
    fireEvent.click(add);
    expect(createRule).toHaveBeenCalledWith({ matchType: "description", pattern: "PAYROLL", categoryId: 2 }, expect.anything());
  });

  it("keeps the rule list folded away until it is opened", () => {
    rules.list = [{ id: 7, match_type: "payee", pattern: "target", category_id: 1, created_at: "2026-10-28" }];
    const { container } = render(<CategoriesCard />);
    const list = container.querySelector("details")!;
    expect(list).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("All rules (1)"));
    expect(list).toHaveAttribute("open");
    expect(within(list).getByText("Payee contains")).toBeInTheDocument();
    expect(within(list).getByText("→ Groceries")).toBeInTheDocument();
    rules.list = [];
  });
});
