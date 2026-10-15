/** Undo and redo for the studio: snapshots of the whole document. Typing in one field coalesces into one step. */
export interface History<T> { past: T[]; present: T; future: T[]; key: string | null }

export const MAX_UNDO = 200;

export const startHistory = <T,>(present: T): History<T> => ({ past: [], present, future: [], key: null });

/** A new state. With the same non-null `key` as the last change (typing in one field), it replaces that step. */
export function record<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (next === h.present) return h;
  if (key !== null && key === h.key) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-MAX_UNDO), present: next, future: [], key };
}
export function undo<T>(h: History<T>): History<T> {
  const prev = h.past.at(-1);
  return prev === undefined ? h : { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], key: null };
}
export function redo<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future;
  return next === undefined ? h : { past: [...h.past, h.present], present: next, future: rest, key: null };
}
/** Replaces the state without an undo step (loading the file, or adopting a change made elsewhere). */
export const reset = <T,>(present: T): History<T> => startHistory(present);
