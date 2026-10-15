import type { ClaudeRunStep } from "@careeros/contract";

/** One line in a run's step list: a label, how many times Claude did it, and where the latest one stands. */
export interface StepGroup { label: string; count: number; state: ClaudeRunStep["state"] }

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Claude Code reports every tool call, so the same label ("Reading your experience") comes up again and again.
 * Show each label once, where it first appeared, with a count; its state is that of its latest occurrence.
 */
export function dedupeSteps(steps: readonly ClaudeRunStep[]): StepGroup[] {
  const out: StepGroup[] = [];
  const at = new Map<string, number>();
  for (const s of steps) {
    const k = norm(s.label);
    if (!k) continue;
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push({ label: s.label.trim(), count: 1, state: s.state }); }
    else { const g = out[i]!; g.count += 1; g.state = s.state; }
  }
  return out;
}

/** What the run is doing now: the latest step's label, or "" before the first one. */
export function currentStep(steps: readonly ClaudeRunStep[]): string {
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i]!.label.trim()) return steps[i]!.label.trim();
  return "";
}
