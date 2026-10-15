import { displayPrompt } from "./labels";

/**
 * The full prompt for reading: wrapped, never scrolling sideways. `shorten` (default) trims workspace paths for
 * reading; pass false where the person may need to select and copy the exact text.
 */
export function PromptView({ prompt, label = "Full prompt", shorten = true }: { prompt: string; label?: string; shorten?: boolean }) {
  return <pre className="prompt-view" aria-label={label} tabIndex={0}>{shorten ? displayPrompt(prompt) : prompt}</pre>;
}
