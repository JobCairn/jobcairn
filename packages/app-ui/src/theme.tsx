import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "graphite" | "paper" | "system";
const KEY = "careeros.theme";

export function resolveTheme(pref: ThemePref): "graphite" | "paper" {
  if (pref !== "system") return pref;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "paper" : "graphite";
}

const Ctx = createContext<[ThemePref, (p: ThemePref) => void]>(["system", () => undefined]);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(() => {
    const saved = localStorage.getItem(KEY);
    return saved === "graphite" || saved === "paper" || saved === "system" ? saved : "system";
  });
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(pref); };
    apply();
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (pref !== "system" || !mq) return undefined;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
  const set = useCallback((p: ThemePref) => { localStorage.setItem(KEY, p); setPref(p); }, []);
  return <Ctx.Provider value={[pref, set]}>{children}</Ctx.Provider>;
}

export const useThemePref = () => useContext(Ctx);
