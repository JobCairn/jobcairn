import { useCallback, useEffect, useMemo, useState } from "react";
import {
  actionKey, isActiveRun, ownTarget,
  type ActionId, type ActionTarget, type ClaudeEngineState, type ClaudeRunRequest, type ClaudeRunView,
} from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";

/** The engine's setup state. Re-read when Claude or settings change. */
export function useClaudeEngine() {
  return useLoad((b) => b.claude.engine(false), [], ["claude", "settings"]);
}

/** Every run (active first). Re-read on each "claude" change, and ticks once a second while one is active. */
export function useClaudeRuns() {
  const runs = useLoad((b) => b.claude.runs(), [], ["claude", "workspace"]);
  const active = (runs.data ?? []).some((r) => isActiveRun(r.status));
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return runs;
}

function keyFor(action: ActionId, target: ActionTarget): string | null {
  try { return actionKey(action, ownTarget(action, target)); } catch { return null; }
}

export interface UseClaudeRun {
  /** The active run, else the latest finished run for this action and target, else null. */
  run: ClaudeRunView | null;
  running: boolean;
  engine: ClaudeEngineState | null;
  ready: boolean;
  /** Starts (or returns the run already going). Rejects with a plain message, which `error` also holds. */
  start(request?: ClaudeRunRequest): Promise<ClaudeRunView>;
  cancel(): Promise<void>;
  error: string | null;
  /** Aliases for lane G's stub: the run's status ("idle" when there is none) and the latest finished run. */
  status: ClaudeRunView["status"] | "idle";
  lastRun: ClaudeRunView | null;
}

/** Start, follow and cancel the one Claude Code run for an action and target. */
export function useClaudeRun(action: ActionId, target: ActionTarget): UseClaudeRun {
  const bridge = useBridge();
  const engine = useClaudeEngine();
  const runs = useClaudeRuns();
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<ClaudeRunRequest>({});
  const key = useMemo(() => keyFor(action, target), [action, target]);
  const run = useMemo(() => {
    const mine = (runs.data ?? []).filter((r) => r.key === key && r.action === action);
    return mine.find((r) => isActiveRun(r.status)) ?? mine[0] ?? null;
  }, [runs.data, key, action]);

  const start = useCallback(async (request?: ClaudeRunRequest) => {
    setError(null);
    const req = request ?? lastRequest;
    setLastRequest(req);
    try {
      const r = await bridge.claude.run(action, target, req);
      runs.reload();
      return r;
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      throw new Error(msg);
    }
  }, [bridge, action, target, lastRequest, runs]);

  const cancel = useCallback(async () => {
    if (!run || (!isActiveRun(run.status) && !run.retry)) return;
    try { await bridge.claude.cancel(run.id); } catch (e) { setError(errorText(e)); }
    runs.reload();
  }, [bridge, run, runs]);

  const lastRun = useMemo(() => (runs.data ?? []).find((r) => r.key === key && r.action === action && !isActiveRun(r.status)) ?? null, [runs.data, key, action]);
  return {
    status: run?.status ?? "idle", lastRun,
    run, running: !!run && isActiveRun(run.status), engine: engine.data ?? null, ready: !!engine.data?.ready, start, cancel,
    error: error ?? engine.error,
  };
}
