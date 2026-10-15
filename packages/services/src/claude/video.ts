import type { Registry } from "@careeros/video";

/** What Claude is told about videos, and how it asks for one. Nothing renders without the candidate. */
export interface VideoFlow {
  types(): { id: string; label: string; description: string }[];
  open(type: string, subject: string): void;
}

/**
 * The video types Claude can ask for come from the registry: built-in plus the workspace's own. In the app, `open`
 * stores the request for the renderer so the Make video dialog opens itself; elsewhere it does nothing.
 */
export function videoFlow(o: { registry(): Registry; open?(type: string, subject: string): void }): VideoFlow {
  return {
    types: () => { try { return o.registry().types.map((t) => ({ id: t.id, label: t.label, description: t.description })); } catch { return []; } },
    open: (type, subject) => o.open?.(type, subject),
  };
}
