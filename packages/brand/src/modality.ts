/**
 * Chrome counts a <select> as :focus-visible even after a mouse click, so its focus ring stayed on after every pick
 * (owner, 2026-10-10). This marks how the person last interacted (`data-modality` on <html>: "pointer" or "keyboard")
 * so the stylesheet can keep the select ring for keyboard focus only. Returns a function that stops tracking.
 */
export function trackInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const set = (m: "pointer" | "keyboard") => { if (root.dataset.modality !== m) root.dataset.modality = m; };
  const onPointer = () => set("pointer");
  const onKey = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) set("keyboard"); };
  doc.addEventListener("pointerdown", onPointer, true);
  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("keydown", onKey, true);
  };
}
