import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "@careeros/brand";
import type { CareerosBridge, ChangeArea } from "@careeros/contract";

const Ctx = createContext<CareerosBridge | null>(null);

export function BridgeProvider({ bridge, children }: { bridge: CareerosBridge; children: ReactNode }) {
  return <Ctx.Provider value={bridge}>{children}</Ctx.Provider>;
}

export function useBridge(): CareerosBridge {
  const b = useContext(Ctx);
  if (!b) throw new Error("useBridge needs a BridgeProvider");
  return b;
}

/** Strips IPC wrapper text so people see only the plain message. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "").split("\n")[0]!;
}

export function useLoad<T>(load: (b: CareerosBridge) => Promise<T>, deps: unknown[], areas: ChangeArea[]) {
  const bridge = useBridge();
  const [state, setState] = useState<{ data?: T; error: string | null; loading: boolean }>({ error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current(bridge).then(
      (data) => { if (live) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (live) setState((s) => ({ data: s.data, error: errorText(e), loading: false })); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, tick, ...deps]);

  const key = areas.join(",");
  useEffect(() => {
    if (!key) return undefined;
    const wanted = key.split(",");
    return bridge.onChange((e) => { if (e.areas.some((a) => wanted.includes(a))) reload(); });
  }, [bridge, key, reload]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** Runs one mutation per key at a time and reports the result as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    if (inflight.current.has(key)) return undefined;
    inflight.current.add(key);
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast({ text: ok, tone: "success" });
      return r;
    } catch (e) {
      toast({ text: errorText(e), tone: "danger" });
      return undefined;
    } finally {
      inflight.current.delete(key);
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}
