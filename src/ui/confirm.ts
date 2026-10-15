import { confirm } from "@tauri-apps/plugin-dialog";

/**
 * Ask before something that cannot be taken back, and wait for the answer.
 *
 * Use this, never the browser's `confirm()`: the dialog plugin replaces that
 * with an async version whose Promise is always truthy, so
 * `if (confirm(...))` goes ahead without asking. `confirm.test.ts` fails if
 * any screen calls it.
 */
export function askToConfirm(
  message: string,
  options: { okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return confirm(message, { title: "Ledgerly", kind: "warning", ...options });
}
