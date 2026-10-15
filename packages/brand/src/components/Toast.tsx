import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../cx";

type Tone = "success" | "danger" | "neutral";
/** An optional button in the toast, such as "Open". Clicking it runs `onClick` and dismisses the toast. */
export interface ToastAction { label: string; onClick: () => void; ariaLabel?: string }
interface Msg { id: number; tone: Tone; text: string; action?: ToastAction }
/** `timeoutMs`: how long this one stays (an Undo toast stays longer than the default). */
type Push = (t: { text: string; tone?: Tone; action?: ToastAction; timeoutMs?: number }) => void;

const ToastContext = createContext<Push>(() => undefined);
let seq = 0;

export function ToastProvider({ children, timeoutMs = 5000 }: { children: ReactNode; timeoutMs?: number }) {
  const [list, setList] = useState<Msg[]>([]);
  // Pending auto-dismiss timers, cleared on unmount so none fires after the provider is gone.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); timers.current.clear(); }, []);
  const dismiss = useCallback((id: number) => setList((l) => l.filter((m) => m.id !== id)), []);
  const push = useCallback<Push>((t) => {
    const id = ++seq;
    setList((l) => [...l, { id, tone: t.tone ?? "neutral", text: t.text, ...(t.action ? { action: t.action } : {}) }]);
    const timer = setTimeout(() => { timers.current.delete(timer); dismiss(id); }, t.timeoutMs ?? timeoutMs);
    timers.current.add(timer);
  }, [dismiss, timeoutMs]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((m) => (
          <div key={m.id} className={cx("toast", `toast--${m.tone}`)}>
            <span className="toast__text">{m.text}</span>
            {m.action ? (
              <button type="button" className="toast__action" aria-label={m.action.ariaLabel} onClick={() => { m.action!.onClick(); dismiss(m.id); }}>{m.action.label}</button>
            ) : null}
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(m.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = (): Push => useContext(ToastContext);
