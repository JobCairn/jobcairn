import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileViewer } from "./FileViewer";
import type { ViewerFile } from "./model";

/**
 * The file viewer for one list of files: `open(rel)` shows that file, and Left/Right step through `files`.
 * A file that isn't in the list (a one-off, or one that just left it) opens on its own.
 *
 *   const viewer = useFileViewer(files.map((f) => ({ rel: f.rel, title: f.label, at: f.at })));
 *   <button onClick={() => viewer.open(f.rel)}>…</button> … {viewer.element}
 */
export function useFileViewer(files: ViewerFile[]): { open: (rel: string, title?: string) => void; close: () => void; element: ReactNode; openRel: string | null } {
  const [current, setCurrent] = useState<ViewerFile | null>(null);
  const open = useCallback((rel: string, title?: string) => setCurrent({ rel, title }), []);
  const close = useCallback(() => setCurrent(null), []);
  const at = current ? files.findIndex((f) => f.rel === current.rel) : -1;
  const list = at >= 0 ? files : current ? [current] : [];
  // Portalled to <body> so a scrolling, transformed or clipped ancestor (the mail reader's panes) never clips the panel.
  // React context (bridge, toasts, player) still flows through a portal; the theme lives on <html>.
  const element = current && typeof document !== "undefined" ? createPortal(
    <FileViewer files={list} index={at >= 0 ? at : 0} onClose={close} onIndex={(i) => { const f = list[i]; if (f) setCurrent({ rel: f.rel }); }} />,
    document.body,
  ) : null;
  return { open, close, element, openRel: current?.rel ?? null };
}
