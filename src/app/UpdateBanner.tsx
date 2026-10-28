import { useEffect, useState } from "react";
import { Button } from "../ui/components";
import { updater as realUpdater, type AvailableUpdate, type Updater } from "../data/updater";

type State =
  | { kind: "none" }
  | { kind: "ready"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate; pct: number | null }
  | { kind: "failed"; update: AvailableUpdate; message: string };

// Checks GitHub once per launch. Test mode (npm run tauri dev) never checks:
// it already runs the newest code.
export function UpdateBanner({ updater = realUpdater, enabled = !import.meta.env.DEV }:
  { updater?: Updater; enabled?: boolean }) {
  const [state, setState] = useState<State>({ kind: "none" });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    updater.check()
      .then((update) => { if (live && update) setState({ kind: "ready", update }); })
      .catch(() => { /* offline or GitHub unreachable: try again next launch */ });
    return () => { live = false; };
  }, [enabled, updater]);

  if (state.kind === "none") return null;
  const { update } = state;

  async function install() {
    setState({ kind: "installing", update, pct: null });
    try {
      await update.install((pct) => setState({ kind: "installing", update, pct }));
      await updater.relaunch();
    } catch (e) {
      setState({ kind: "failed", update, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className={`notice ${state.kind === "failed" ? "neg" : "info"} update-banner`} role="status">
      <span className="update-banner-text">
        {state.kind === "ready" && `Version ${update.version} is ready.`}
        {state.kind === "installing" && (state.pct === null ? "Downloading…" : `Downloading… ${state.pct}%`)}
        {state.kind === "failed" && `The update didn't install: ${state.message}`}
      </span>
      {state.kind === "ready" && <>
        <Button size="sm" onClick={install}>Install and restart</Button>
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: "none" })}>Later</Button>
      </>}
      {state.kind === "installing" && <Button size="sm" disabled loading>Installing</Button>}
      {state.kind === "failed" && <>
        <Button size="sm" onClick={install}>Try again</Button>
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: "none" })}>Later</Button>
      </>}
    </div>
  );
}
