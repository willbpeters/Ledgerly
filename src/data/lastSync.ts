import type { SyncReport } from "../domain/types";

const KEY = "ledgerly.lastSync";

/**
 * The most recent sync report, kept so the side panel can still mention what a
 * sync skipped after the page reloads. Nothing here is authoritative; it is a
 * convenience copy of what the Rust core already reported.
 */
export function readLastSync(): SyncReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SyncReport;
    if (typeof parsed?.holdings_skipped !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLastSync(report: SyncReport) {
  try { localStorage.setItem(KEY, JSON.stringify(report)); } catch { /* storage unavailable */ }
}

export function clearLastSync() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
