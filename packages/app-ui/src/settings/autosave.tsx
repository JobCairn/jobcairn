import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Icon, Icons } from "@careeros/brand";
import type { SettingsKind } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";

/** What one settings form tells the page: is anything saving, and which fields failed to save. */
export interface FormSaveState { saving: boolean; failed: string[]; /** Fields showing a check error ("Enter a number."), so not saved. */ invalid: string[] }
/** The most recent saved change, so the page can offer to put it back. */
export interface LastChange { label: string; undo: () => void }

interface Ctx {
  report: (formId: string, state: FormSaveState) => void;
  saved: (change: LastChange | null) => void;
}

const AutosaveCtx = createContext<Ctx>({ report: () => undefined, saved: () => undefined });

interface Summary { saving: boolean; failed: string[]; invalid: string[]; savedOnce: boolean; last: LastChange | null }
const SummaryCtx = createContext<Summary>({ saving: false, failed: [], invalid: [], savedOnce: false, last: null });

/**
 * Collects the save state of every autosaving form on a page (Settings has three: Profile, Search and Video), so a
 * single line by the tab bar can say "Saving…", "All changes saved" or what failed.
 */
export function AutosaveProvider({ children }: { children: ReactNode }) {
  const [forms, setForms] = useState<Record<string, FormSaveState>>({});
  const [savedOnce, setSavedOnce] = useState(false);
  const [last, setLast] = useState<LastChange | null>(null);
  const report = useCallback((formId: string, state: FormSaveState) => {
    setForms((f) => {
      const prev = f[formId];
      if (prev && prev.saving === state.saving && prev.failed.join("\n") === state.failed.join("\n") && prev.invalid.join("\n") === state.invalid.join("\n")) return f;
      return { ...f, [formId]: state };
    });
  }, []);
  const saved = useCallback((change: LastChange | null) => { setSavedOnce(true); setLast(change); }, []);
  const ctx = useMemo(() => ({ report, saved }), [report, saved]);
  const summary = useMemo<Summary>(() => {
    const all = Object.values(forms);
    return { saving: all.some((s) => s.saving), failed: all.flatMap((s) => s.failed), invalid: all.flatMap((s) => s.invalid), savedOnce, last };
  }, [forms, savedOnce, last]);
  return <AutosaveCtx.Provider value={ctx}><SummaryCtx.Provider value={summary}>{children}</SummaryCtx.Provider></AutosaveCtx.Provider>;
}

export const useAutosave = () => useContext(AutosaveCtx);

/** Reports one form's save state to the page while it's mounted. */
export function useReportSaveState(formId: string, state: FormSaveState) {
  const { report } = useAutosave();
  const key = `${state.saving}|${state.failed.join("\n")}|${state.invalid.join("\n")}`;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => { report(formId, stateRef.current); }, [report, formId, key]);
  useEffect(() => () => report(formId, { saving: false, failed: [], invalid: [] }), [report, formId]);
}

/**
 * The page-level line that sits on the tab bar. Polite live region: screen readers hear "Saving…", then
 * "All changes saved", without being interrupted. Undo puts back only the last change.
 */
export function AutosaveStatus() {
  const { saving, failed, invalid, savedOnce, last } = useContext(SummaryCtx);
  const text = failed.length ? (failed.length === 1 ? `Couldn't save ${failed[0]}` : `Couldn't save ${failed.length} changes`)
    : invalid.length ? (invalid.length === 1 ? `Fix ${invalid[0]} to save it` : `Fix ${invalid.length} fields to save them`)
    : saving ? "Saving…"
    : savedOnce ? "All changes saved" : "Changes save automatically";
  const tone = failed.length || invalid.length ? "failed" : saving ? "saving" : savedOnce ? "saved" : "idle";
  return (
    <div className="autosave-status" data-tour="settings-autosave">
      <span className={`autosave-status__line autosave-status__line--${tone}`}>
        {tone === "saved" ? <Icon icon={Icons.check} size="sm" /> : null}
        <span role="status" aria-live="polite">{text}</span>
        {tone === "saved" && last ? (
          <Button size="sm" variant="ghost" className="autosave-status__undo" onClick={last.undo}
            aria-label={`Undo the change to ${last.label}`}>Undo</Button>
        ) : null}
      </span>
    </div>
  );
}

export type SaveNote = { state: "saving" } | { state: "saved" } | { state: "failed"; text: string };

/**
 * Saves single settings fields one at a time, in order, with a per-field note ("Saving…", "Saved", or what failed),
 * and reports to the page line. For custom controls that don't go through FieldForm (Settings › Video lengths).
 */
export function useFieldSaver(kind: SettingsKind, formId: string, labelOf: (path: string) => string) {
  const bridge = useBridge();
  const { saved } = useAutosave();
  const [notes, setNotes] = useState<Record<string, SaveNote>>({});
  const [invalid, setInvalid] = useState<string[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const live = useRef(true);
  useEffect(() => { live.current = true; const t = timers.current; return () => { live.current = false; for (const id of t.values()) clearTimeout(id); }; }, []);
  const setNote = useCallback((path: string, n: SaveNote | null) => {
    if (!live.current) return;
    const old = timers.current.get(path);
    if (old) { clearTimeout(old); timers.current.delete(path); }
    setNotes((s) => { const { [path]: _d, ...rest } = s; return n ? { ...rest, [path]: n } : rest; });
    if (n?.state === "saved") {
      timers.current.set(path, setTimeout(() => {
        timers.current.delete(path);
        if (live.current) setNotes((s) => (s[path]?.state === "saved" ? (({ [path]: _d, ...rest }) => rest)(s) : s));
      }, 2400));
    }
  }, []);
  const save = useCallback(function save(path: string, value: unknown, prev?: unknown) {
    setNote(path, { state: "saving" });
    const job = queue.current.then(() => bridge.settings.save(kind, [{ path, value }]));
    queue.current = job.catch(() => undefined);
    job.then(
      () => {
        setNote(path, { state: "saved" });
        saved(prev !== undefined ? { label: labelOf(path), undo: () => save(path, prev) } : null);
      },
      (e: unknown) => setNote(path, { state: "failed", text: errorText(e) }),
    );
  }, [bridge, kind, saved, setNote, labelOf]);
  const markInvalid = useCallback((path: string, bad: boolean) => {
    setInvalid((l) => (bad ? (l.includes(path) ? l : [...l, path]) : l.filter((p) => p !== path)));
  }, []);
  useReportSaveState(formId, {
    saving: Object.values(notes).some((n) => n.state === "saving"),
    failed: Object.entries(notes).flatMap(([p, n]) => (n.state === "failed" ? [labelOf(p)] : [])),
    invalid: invalid.map(labelOf),
  });
  return { notes, save, clearNote: (path: string) => setNote(path, null), markInvalid };
}
