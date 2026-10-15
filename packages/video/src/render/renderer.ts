import type { LintReport } from "../hf.js";

export interface RenderJob { compDir: string; out: string; quality: "draft" | "final"; signal: AbortSignal; onPct(p: number): void }

/** Turns a composition folder into an MP4. HyperFrames is the v1 implementation; "electron" is reserved for the offscreen fallback. */
export interface Renderer {
  id: "hyperframes" | "electron";
  /** `skipCheck`: run only the quick static lint, not the browser check (the person chose "Make it without the check"). */
  lint(compDir: string, signal: AbortSignal, opts?: { skipCheck?: boolean }): Promise<LintReport>;
  snapshot(compDir: string, times: number[], signal: AbortSignal): Promise<string | null>;
  render(job: RenderJob): Promise<void>;
}
