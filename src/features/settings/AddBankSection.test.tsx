import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AddBankSection, SIMPLEFIN_MY_ACCOUNT_URL, type AddBankSectionProps } from "./AddBankSection";

function props(over: Partial<AddBankSectionProps> = {}): AddBankSectionProps {
  return { onOpenSimplefin: vi.fn(), onUpdateConnection: vi.fn(), updating: false, ...over };
}

describe("AddBankSection", () => {
  it("points at the SimpleFIN page where banks are added", () => {
    expect(SIMPLEFIN_MY_ACCOUNT_URL).toBe("https://beta-bridge.simplefin.org/my-account");
  });

  it("opens SimpleFIN from its button", () => {
    const onOpenSimplefin = vi.fn();
    render(<AddBankSection {...props({ onOpenSimplefin })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open SimpleFIN" }));
    expect(onOpenSimplefin).toHaveBeenCalled();
  });

  it("says where to click on SimpleFIN and to sync afterwards", () => {
    render(<AddBankSection {...props()} />);
    expect(screen.getByText(/Financial Institutions/)).toBeInTheDocument();
    expect(screen.getByText(/Sync now/)).toBeInTheDocument();
  });

  it("updates the connection with a pasted token, trimmed", () => {
    const onUpdateConnection = vi.fn();
    render(<AddBankSection {...props({ onUpdateConnection })} />);
    const button = screen.getByRole("button", { name: "Update connection" });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/New setup token/), { target: { value: "  abc123  " } });
    fireEvent.click(button);
    expect(onUpdateConnection).toHaveBeenCalledWith("abc123");
  });

  it("mentions the backup made before updating", () => {
    render(<AddBankSection {...props()} />);
    expect(screen.getByText(/backs up your data first/)).toBeInTheDocument();
  });
});
