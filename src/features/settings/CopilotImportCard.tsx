import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCopilotPreview, useCopilotImport } from "../../data/queries";
import { useToast } from "../../ui/toast";
import { CopilotImportPanel } from "./CopilotImportPanel";

export function CopilotImportCard() {
  const preview = useCopilotPreview();
  const importer = useCopilotImport();
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  // Rows Copilot does not have start ticked: the owner deletes a transaction in
  // Copilot when they are paid back, and removing here is restorable.
  const [removeIds, setRemoveIds] = useState<Set<number>>(new Set());

  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });
  const offered = preview.data?.not_in_copilot.map((n) => n.txn_id) ?? [];

  return (
    <CopilotImportPanel
      plan={preview.data ?? null}
      result={importer.data ?? null}
      busy={preview.isPending || importer.isPending}
      removeIds={removeIds}
      onToggleRemove={(id) => setRemoveIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      })}
      onSetAllRemove={(all) => setRemoveIds(new Set(all ? offered : []))}
      onChoose={async () => {
        const file = await open({
          title: "Choose your Copilot export",
          filters: [{ name: "Copilot export", extensions: ["csv"] }],
        });
        if (typeof file !== "string") return;
        setPath(file);
        importer.reset();
        preview.mutate(file, {
          onSuccess: (plan) => setRemoveIds(new Set(plan.not_in_copilot.map((n) => n.txn_id))),
          onError: failed("Couldn't read that export"),
        });
      }}
      onImport={() => {
        if (path) importer.mutate({ path, removeIds: [...removeIds] }, { onError: failed("Import didn't happen") });
      }}
    />
  );
}
