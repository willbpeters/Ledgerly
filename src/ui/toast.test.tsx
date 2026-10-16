import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Pusher({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return (
    <button onClick={() => toast.push({ tone: "neutral", title: "Removed", action: { label: "Undo", onClick: onUndo } })}>
      push
    </button>
  );
}

describe("toast actions", () => {
  it("shows the action and runs it once, closing the toast", () => {
    const onUndo = vi.fn();
    render(<ToastProvider><Pusher onUndo={onUndo} /></ToastProvider>);
    fireEvent.click(screen.getByText("push"));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Removed")).toBeNull();
  });
});
