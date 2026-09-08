import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "ledgerly.theme";

export function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage unavailable */ }
  return "system";
}

export function savePref(p: ThemePref) {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolve(pref: ThemePref, sysDark: boolean = systemPrefersDark()): ResolvedTheme {
  return pref === "system" ? (sysDark ? "dark" : "light") : pref;
}

export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

// Apply the stored theme the moment this module loads, before any component
// renders. Waiting for ThemeProvider's effect would mean the first paint uses
// the light palette, and anything reading CSS variables during that first
// render (the charts) would capture the wrong colours and keep them.
if (typeof document !== "undefined") applyTheme(resolve(loadPref()));

interface ThemeCtx { pref: ThemePref; resolved: ResolvedTheme; setPref: (p: ThemePref) => void; }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(loadPref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(pref));

  useEffect(() => {
    const mq = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const update = () => {
      const r = resolve(pref, mq?.matches ?? false);
      setResolved(r);
      applyTheme(r);
    };
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, [pref]);

  const value = useMemo<ThemeCtx>(() => ({
    pref, resolved,
    setPref: (p) => { savePref(p); setPrefState(p); },
  }), [pref, resolved]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
