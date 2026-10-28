import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { IconRail } from "./IconRail";

describe("IconRail", () => {
  it("links to Goals", () => {
    render(<MemoryRouter><IconRail /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/goals");
  });
});
