/**
 * "If it fails, try again": which failed runs are worth starting again on their own, and how long to wait first.
 * Only failures that look passing (the network, a timeout, Chrome or the browser helper going away, Claude's
 * service being busy) are retried; a sign-in problem, a refused step or a missing file never is.
 */

/** Waits before each retry: 30 seconds, then 2 minutes, then 5 minutes (and 5 minutes after that). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;

export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1]!;
}

const TRANSIENT = new RegExp([
  "network", "timed? ?out", "timeout", "ECONN(RESET|REFUSED|ABORTED)", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "socket hang up",
  "fetch failed", "connection (closed|reset|lost|refused)", "browser (closed|disconnected|crashed)", "Chrome isn't connected", "not connected",
  "target closed", "helper", "overloaded", "rate limit", "\\b(429|500|502|503|504|529)\\b", "temporarily unavailable", "try again later",
  "stopped before it finished",
].join("|"), "i");
const NEVER = /sign(ed)? ?(in|out)|log ?in|not signed|consent|isn't installed|too old|didn't write|changed files outside|wasn't allowed|\brefused\b|add-on|credit|billing|quota exceeded/i;

/** True when a failed run's error looks passing, so starting it again later may work. */
export function isTransientFailure(error: string): boolean {
  return TRANSIENT.test(error) && !NEVER.test(error);
}
