import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The window has no native title bar (tauri.conf.json: decorations false), so
// the command bar carries minimise, maximise and close itself.
function appWindow() {
  try { return getCurrentWindow(); } catch { return null; /* outside the app, e.g. tests */ }
}

const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1 };

export function WindowControls() {
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    const win = appWindow();
    if (!win) return;
    let unlisten: Promise<() => void> | undefined;
    try {
      const check = () => { win.isMaximized().then(setMaximised).catch(() => {}); };
      check();
      unlisten = win.onResized(check);
    } catch { return; /* outside the app, e.g. tests */ }
    return () => { unlisten?.then((f) => f()).catch(() => {}); };
  }, []);

  return (
    <div className="win-controls">
      <button className="win-btn" aria-label="Minimise" title="Minimise" onClick={() => appWindow()?.minimize()}>
        <svg {...glyph}><path d="M0 5.5h10" /></svg>
      </button>
      <button className="win-btn" aria-label={maximised ? "Restore" : "Maximise"} title={maximised ? "Restore" : "Maximise"}
        onClick={() => appWindow()?.toggleMaximize()}>
        {maximised
          ? <svg {...glyph}><rect x="0.5" y="2.5" width="7" height="7" /><path d="M2.5 2.5V0.5h7v7h-2" /></svg>
          : <svg {...glyph}><rect x="0.5" y="0.5" width="9" height="9" /></svg>}
      </button>
      <button className="win-btn close" aria-label="Close" title="Close" onClick={() => appWindow()?.close()}>
        <svg {...glyph}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  );
}
