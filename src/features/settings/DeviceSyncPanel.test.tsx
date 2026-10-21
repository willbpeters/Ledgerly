import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DeviceSyncPanel, type DeviceSyncPanelProps } from "./DeviceSyncPanel";
import type { DeviceSyncStatus } from "../../domain/types";

const off: DeviceSyncStatus = {
  enabled: false, folder: null, this_computer: "WILL-LAPTOP", others: [],
  waiting: 0, unsent: 0, last: null, last_error: null,
};

const on: DeviceSyncStatus = {
  ...off,
  enabled: true,
  folder: "G:\\My Drive\\Ledgerly Sync",
  others: [{ id: "pc", name: "WILL-PC", last_sync: "2026-10-16T09:30:12" }],
  last: { at: "2026-10-16T09:31:00", pushed: 2, applied: 3, waiting: 0, skipped: 0, newer_files: 0 },
};

function props(over: Partial<DeviceSyncPanelProps> = {}): DeviceSyncPanelProps {
  return {
    status: off, today: "2026-10-16", busy: false,
    onStartFirst: vi.fn(), onJoin: vi.fn(), onSyncNow: vi.fn(), onStop: vi.fn(),
    ...over,
  };
}

describe("DeviceSyncPanel", () => {
  it("offers both ways to begin when sync is off", () => {
    const onStartFirst = vi.fn();
    const onJoin = vi.fn();
    render(<DeviceSyncPanel {...props({ onStartFirst, onJoin })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start with this computer…" }));
    fireEvent.click(screen.getByRole("button", { name: "Join…" }));
    expect(onStartFirst).toHaveBeenCalled();
    expect(onJoin).toHaveBeenCalled();
  });

  it("names the folder and the other computer with when it last synced", () => {
    render(<DeviceSyncPanel {...props({ status: on })} />);
    expect(screen.getByText("G:\\My Drive\\Ledgerly Sync")).toBeInTheDocument();
    expect(screen.getByText(/WILL-PC — last synced Today, 09:30/)).toBeInTheDocument();
  });

  it("says when the other computer has not synced yet", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, others: [] } })} />);
    expect(screen.getByText(/hasn't synced yet/)).toBeInTheDocument();
  });

  it("explains edits waiting for a bank sync", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, waiting: 2 } })} />);
    expect(screen.getByText(/2 edits from your other computer are waiting/)).toBeInTheDocument();
  });

  it("asks for an update when the other computer runs a newer Ledgerly", () => {
    const status = { ...on, last: { ...on.last!, newer_files: 1 } };
    render(<DeviceSyncPanel {...props({ status })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/newer version of Ledgerly/);
  });

  it("shows the last error", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, last_error: "Couldn't write G:\\x" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't write G:\\x");
  });

  it("syncs now and stops", () => {
    const onSyncNow = vi.fn();
    const onStop = vi.fn();
    render(<DeviceSyncPanel {...props({ status: on, onSyncNow, onStop })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop syncing" }));
    expect(onSyncNow).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
  });
});
