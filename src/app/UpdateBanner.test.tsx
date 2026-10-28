import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";
import type { AvailableUpdate, Updater } from "../data/updater";

function fake(update: Partial<AvailableUpdate> | null, opts: { checkFails?: boolean } = {}) {
  const relaunch = vi.fn(async () => {});
  const install = vi.fn(async (onProgress: (pct: number | null) => void) => { onProgress(40); });
  const updater: Updater = {
    check: vi.fn(async () => {
      if (opts.checkFails) throw new Error("offline");
      return update && { version: "0.2.0", install, ...update };
    }),
    relaunch,
  };
  return { updater, relaunch, install };
}

describe("UpdateBanner", () => {
  it("offers a found update", async () => {
    render(<UpdateBanner updater={fake({}).updater} enabled />);
    expect(await screen.findByText("Version 0.2.0 is ready.")).toBeInTheDocument();
  });

  it("Later hides it", async () => {
    render(<UpdateBanner updater={fake({}).updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Version 0.2.0 is ready.")).toBeNull();
  });

  it("installs, then relaunches", async () => {
    const f = fake({});
    render(<UpdateBanner updater={f.updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(f.relaunch).toHaveBeenCalledTimes(1));
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("shows progress while installing", async () => {
    let finish!: () => void;
    const install = vi.fn((onProgress: (pct: number | null) => void) => {
      onProgress(40);
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    render(<UpdateBanner updater={fake({ install }).updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Downloading… 40%")).toBeInTheDocument();
    finish();
  });

  it("shows a failed install with Try again", async () => {
    const install = vi.fn<AvailableUpdate["install"]>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const f = fake({ install });
    render(<UpdateBanner updater={f.updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("The update didn't install: disk full")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(f.relaunch).toHaveBeenCalledTimes(1));
  });

  it("shows nothing with no update, when offline, or when turned off", async () => {
    const none = fake(null), offline = fake({}, { checkFails: true }), off = fake({});
    const { container: a } = render(<UpdateBanner updater={none.updater} enabled />);
    const { container: b } = render(<UpdateBanner updater={offline.updater} enabled />);
    const { container: c } = render(<UpdateBanner updater={off.updater} enabled={false} />);
    await waitFor(() => expect(none.updater.check).toHaveBeenCalled());
    await waitFor(() => expect(offline.updater.check).toHaveBeenCalled());
    expect(a).toBeEmptyDOMElement();
    expect(b).toBeEmptyDOMElement();
    expect(c).toBeEmptyDOMElement();
    expect(off.updater.check).not.toHaveBeenCalled();
  });
});
