import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useToast } from "../ui/toast";
import type { BankTransaction } from "../domain/types";

/** The parts of a transaction an action in Spending can change — what Undo
 *  hands back to put it as it was. Mirrors `store::RowState`. */
export interface RowState {
  id: number;
  category_id: number | null;
  category_source: "auto" | "manual";
  reviewed: boolean;
  removed: boolean;
}

export function stateOf(t: BankTransaction): RowState {
  return {
    id: t.id, category_id: t.category_id, category_source: t.category_source,
    reviewed: t.reviewed, removed: t.removed,
  };
}

/**
 * After an action, offer Undo: a toast whose button puts `before` back.
 * Capture `before` from the rows as they were *before* the action ran.
 */
export function useOfferUndo() {
  const qc = useQueryClient();
  const toast = useToast();
  const restore = useMutation({
    mutationFn: (states: RowState[]) => api.bankTransactions.restore(states),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bankTxns"] }); },
  });
  return (title: string, before: BankTransaction[]) => {
    const states = before.map(stateOf);
    toast.push({
      tone: "neutral",
      title,
      action: {
        label: "Undo",
        onClick: () => restore.mutate(states, {
          onError: (e) => toast.push({ tone: "neg", title: "Couldn't undo", body: String(e) }),
        }),
      },
    });
  };
}

/** Undo for a split or an unsplit: the pieces go back first, then the row's
 *  own category, source and review state. The pieces must come first, because
 *  saving pieces empties the row's category. */
async function undoSplit(before: BankTransaction): Promise<void> {
  await api.bankTransactions.setSplits(
    before.id,
    before.splits.map(({ category_id, amount, note }) => ({ category_id, amount, note })),
  );
  await api.bankTransactions.restore([stateOf(before)]);
}

/**
 * After saving or clearing a split, offer Undo. Plain promises rather than a
 * mutation: the editor that called this has closed by the time Undo is
 * clicked, and the query client and toasts outlive it.
 */
export function useOfferSplitUndo() {
  const qc = useQueryClient();
  const toast = useToast();
  return (title: string, before: BankTransaction) => {
    toast.push({
      tone: "neutral",
      title,
      action: {
        label: "Undo",
        onClick: () => {
          undoSplit(before)
            .then(() => qc.invalidateQueries({ queryKey: ["bankTxns"] }))
            .catch((e) => toast.push({ tone: "neg", title: "Couldn't undo", body: String(e) }));
        },
      },
    });
  };
}

const ASK_KEY = "ledgerly.askBeforeRemove";

/** Whether to ask before removing a transaction. On unless the owner chose
 *  "don't ask again". Storage can be unavailable; then it simply asks. */
export function askBeforeRemove(): boolean {
  try {
    return localStorage.getItem(ASK_KEY) !== "no";
  } catch {
    return true;
  }
}

export function setAskBeforeRemove(ask: boolean): void {
  try {
    if (ask) localStorage.removeItem(ASK_KEY);
    else localStorage.setItem(ASK_KEY, "no");
  } catch {
    // Nothing to do: without storage it keeps asking, which is the safe side.
  }
}
