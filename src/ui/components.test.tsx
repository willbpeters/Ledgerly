import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Button, Badge, StatCard, Tabs, EmptyState } from "./components";
import { DataTable } from "./DataTable";

describe("shared components", () => {
  it("Button applies variant class and shows spinner when loading", () => {
    const { container } = render(<Button variant="danger" loading>Go</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("btn-danger");
    expect(btn.disabled).toBe(true);
    expect(container.querySelector(".spinner")).not.toBeNull();
  });

  it("Badge renders tone", () => {
    render(<Badge tone="pos">Synced</Badge>);
    expect(screen.getByText("Synced").className).toContain("pos");
  });

  it("StatCard colours by delta sign", () => {
    render(<StatCard label="Gain" value="$5" delta={-1} />);
    expect(screen.getByText("$5").className).toContain("neg");
  });

  it("Tabs calls onChange", () => {
    const onChange = vi.fn();
    render(<Tabs items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText("B"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("EmptyState shows title and body", () => {
    render(<EmptyState title="Nothing" body="Add something" />);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });

  it("DataTable renders columns and rows with alignment", () => {
    render(<DataTable
      columns={[{ key: "n", label: "Name", align: "left", render: (r: { n: string; v: number }) => r.n },
                { key: "v", label: "Value", render: (r) => r.v }]}
      rows={[{ n: "VTI", v: 3 }]}
      getKey={(r) => r.n}
    />);
    expect(screen.getByText("VTI").className).toContain("left");
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
