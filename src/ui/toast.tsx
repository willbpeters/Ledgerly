import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface ToastAction { label: string; onClick: () => void }
export interface Toast {
  id: number; tone: "pos" | "neg" | "neutral"; title: string; body?: string;
  /** One small button, such as Undo. Clicking it closes the toast. */
  action?: ToastAction;
}
interface ToastCtx { push: (t: Omit<Toast, "id">) => void; }
const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    // A toast with an action stays a little longer: there has to be time to
    // read it and change your mind.
    setTimeout(() => dismiss(id), t.action ? 8000 : 6000);
  }, [dismiss]);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <div className="row center between" style={{ gap: 12 }}>
              <div className="toast-title">{t.title}</div>
              {t.action && (
                <button className="btn btn-ghost btn-sm" onClick={() => { dismiss(t.id); t.action?.onClick(); }}>
                  {t.action.label}
                </button>
              )}
            </div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
