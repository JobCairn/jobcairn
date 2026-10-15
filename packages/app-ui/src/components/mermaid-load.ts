/**
 * Mermaid, loaded only when a page shows a diagram (it is large). Its own module so tests can replace it:
 * jsdom has no SVG layout, so the real library can't draw there.
 */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let pending: Promise<MermaidApi> | null = null;
export function loadMermaid(): Promise<MermaidApi> {
  pending ??= import("mermaid").then((m) => m.default as unknown as MermaidApi).catch((e: unknown) => { pending = null; throw e; });
  return pending;
}
