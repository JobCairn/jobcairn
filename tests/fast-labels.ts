/**
 * Test-only speed-up for jsdom's `labels` and `label.control`.
 *
 * jsdom walks the whole document for every labelable element, and walks it again for every label with a `for`
 * attribute. Testing Library calls `labels` on every element for each `getByLabelText` and for every accessible
 * name, so a screen with ~140 controls and ~70 labels (Settings mounts every tab) costs ~400 ms per query, and
 * `waitFor` callbacks that query repeat that cost every 50 ms. Under load that turned into 10-20 s tests and
 * timeouts. This keeps the HTML spec's result (first element in the root with the id; else the first labelable
 * descendant) but looks ids up with getElementById instead of a tree walk.
 */
const LABELABLE = new Set(["BUTTON", "METER", "OUTPUT", "PROGRESS", "SELECT", "TEXTAREA"]);
const isLabelable = (el: Element): boolean =>
  LABELABLE.has(el.tagName) || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "hidden");

function byId(root: Node, id: string): Element | null {
  if ("getElementById" in root && typeof (root as Document).getElementById === "function") return (root as Document).getElementById(id);
  // A detached tree: its root is an element, which has no getElementById.
  const el = root as Element;
  if (el.nodeType !== 1) return null;
  if (el.getAttribute("id") === id) return el;
  for (const d of el.querySelectorAll("[id]")) if (d.getAttribute("id") === id) return d;
  return null;
}

export function controlOf(label: HTMLLabelElement): Element | null {
  if (label.hasAttribute("for")) {
    const id = label.getAttribute("for")!;
    if (!id) return null;
    const el = byId(label.getRootNode(), id);
    return el && isLabelable(el) ? el : null;
  }
  for (const d of label.querySelectorAll("*")) if (isLabelable(d)) return d;
  return null;
}

function labelsOf(el: Element): HTMLLabelElement[] | null {
  if (!isLabelable(el)) return null;
  const root = el.getRootNode() as ParentNode & Node;
  const all = [...((root as Element).tagName === "LABEL" ? [root as unknown as HTMLLabelElement] : []), ...root.querySelectorAll("label")];
  return all.filter((l) => controlOf(l) === el);
}

export function installFastLabels(win: Window & typeof globalThis = window): void {
  Object.defineProperty(win.HTMLLabelElement.prototype, "control", { configurable: true, get(this: HTMLLabelElement) { return controlOf(this); } });
  for (const name of ["HTMLButtonElement", "HTMLInputElement", "HTMLMeterElement", "HTMLOutputElement", "HTMLProgressElement", "HTMLSelectElement", "HTMLTextAreaElement"] as const) {
    const proto = (win[name] as { prototype: object } | undefined)?.prototype;
    if (proto) Object.defineProperty(proto, "labels", { configurable: true, get(this: Element) { return labelsOf(this); } });
  }
}
