import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AvailableUpdate = {
  version: string;
  /** Downloads and installs; reports percent done, or null when the size is unknown. */
  install: (onProgress: (pct: number | null) => void) => Promise<void>;
};

export type Updater = {
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
};

export const updater: Updater = {
  async check() {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async (onProgress) => {
        let total = 0;
        let received = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress") {
            received += event.data.chunkLength;
            onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
          }
        });
      },
    };
  },
  relaunch,
};
