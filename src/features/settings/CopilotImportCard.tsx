import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCopilotPreview, useCopilotImport } from "../../data/queries";
import { askBeforeRemove, setAskBeforeRemove } from "../../data/undo";
import { useToast } from "../../ui/toast";
import { CopilotImportPanel } from "./CopilotImportPanel";

export function CopilotImportCard() {
  const preview = useCopilotPreview();
  const importer = useCopilotImport();
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [askRemove, setAskRemove] = useState(askBeforeRemove);

  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });

  return (
    <CopilotImportPanel
      plan={preview.data ?? null}
      result={importer.data ?? null}
      busy={preview.isPending || importer.isPending}
      onChoose={async () => {
        const file = await open({
          title: "Choose your Copilot export",
          filters: [{ name: "Copilot export", extensions: ["csv"] }],
        });
        if (typeof file !== "string") return;
        setPath(file);
        importer.reset();
        preview.mutate(file, { onError: failed("Couldn't read that export") });
      }}
      onImport={() => {
        if (path) importer.mutate(path, { onError: failed("Import didn't happen") });
      }}
    >
      <label className="row center muted" style={{ gap: 6, fontSize: 11 }}>
        <input type="checkbox" checked={askRemove}
          onChange={(e) => { setAskBeforeRemove(e.target.checked); setAskRemove(e.target.checked); }} />
        Ask before removing a transaction in Spending (Undo is always offered)
      </label>
    </CopilotImportPanel>
  );
}
