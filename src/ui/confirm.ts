import { confirm, message } from "@tauri-apps/plugin-dialog";

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

export type RemoveAnswer = "remove" | "remove-always" | "cancel";

/** The short question before removing a transaction. "Remove, don't ask
 *  again" saves a click every time after; Undo is the safety net instead. */
export async function askToRemove(): Promise<RemoveAnswer> {
  const choice = await message("Remove this transaction from spending?", {
    title: "Ledgerly",
    kind: "info",
    buttons: { yes: "Remove", no: "Remove, don't ask again", cancel: "Cancel" },
  });
  if (choice === "Remove") return "remove";
  if (choice === "Remove, don't ask again") return "remove-always";
  return "cancel";
}
