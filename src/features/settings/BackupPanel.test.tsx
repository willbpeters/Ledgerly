import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BackupPanel, type BackupPanelProps } from "./BackupPanel";
import type { BackupEntry, BackupStatus } from "../../domain/types";

const entry: BackupEntry = {
  file_name: "ledgerly-2026-10-14-093012-manual.sqlite",
  path: "C:\\backups\\ledgerly-2026-10-14-093012-manual.sqlite",
  date: "2026-10-14", time: "09:30:12", kind: "manual", size: 1.5 * 1024 * 1024,
};

const status: BackupStatus = {
  latest: entry, last_attempt: null, restore_error: null, extra_folder: null,
  backups_folder: "C:\\backups",
};

function props(over: Partial<BackupPanelProps> = {}): BackupPanelProps {
  return {
    status, backups: [entry], today: "2026-10-14",
    busy: { backingUp: false, exporting: false, restoring: false },
    exportedTo: null,
    onBackUpNow: vi.fn(), onChooseExtra: vi.fn(), onRemoveExtra: vi.fn(),
    onRestore: vi.fn(), onRestoreFromFile: vi.fn(), onExport: vi.fn(), onRevealExport: vi.fn(),
    ...over,
  };
}

describe("BackupPanel", () => {
  it("shows when the last backup was made", () => {
    render(<BackupPanel {...props()} />);
    expect(screen.getByText(/Last backup: Today, 09:30 \(manual\)/)).toBeInTheDocument();
  });

  it("lists backups with their kind and size", () => {
    render(<BackupPanel {...props()} />);
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
  });

  it("restores the chosen backup", () => {
    const onRestore = vi.fn();
    render(<BackupPanel {...props({ onRestore })} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(entry);
  });

  it("explains an empty list", () => {
    render(<BackupPanel {...props({ backups: [], status: { ...status, latest: null } })} />);
    expect(screen.getByText("No backups yet")).toBeInTheDocument();
    expect(screen.getByText(/Last backup: none yet/)).toBeInTheDocument();
  });

  it("says when the last backup failed, and why", () => {
    const failed = { at: "2026-10-14T09:00:00", kind: "daily" as const, file: null, error: "Disk full", warning: null };
    render(<BackupPanel {...props({ status: { ...status, last_attempt: failed } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Last backup failed: Disk full");
  });

  it("says when a restore did not happen", () => {
    render(<BackupPanel {...props({ status: { ...status, restore_error: "That file isn't a Tally backup." } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Restore didn't happen: That file isn't a Tally backup.");
  });

  it("offers Remove only when an extra folder is set", () => {
    const { rerender } = render(<BackupPanel {...props()} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    rerender(<BackupPanel {...props({ status: { ...status, extra_folder: "E:\\Backups" } })} />);
    expect(screen.getByText("E:\\Backups")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("points to a finished export", () => {
    const onRevealExport = vi.fn();
    render(<BackupPanel {...props({ exportedTo: "D:\\Tally export 2026-10-14", onRevealExport })} />);
    expect(screen.getByText(/Exported to D:\\Tally export 2026-10-14/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(onRevealExport).toHaveBeenCalled();
  });
});
