import { describe, expect, it } from "vitest";
import { isTransientFailure, retryDelay } from "../../src/claude/retry.js";

describe("if it fails, try again", () => {
  it("waits 30 seconds, 2 minutes, then 5 minutes", () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([30_000, 120_000, 300_000, 300_000]);
  });

  it("retries passing failures only", () => {
    for (const e of [
      "Claude Code stopped before it finished: socket hang up",
      "Claude didn't finish: API Error: 529 overloaded",
      "Claude didn't finish: Chrome isn't connected any more. Stop browsing and finish with the jobs you found.",
      "Claude Code stopped before it finished: Error: connect ECONNREFUSED 127.0.0.1:9222",
      "Claude didn't finish: The browser helper stopped.",
    ]) expect(isTransientFailure(e), e).toBe(true);
    for (const e of [
      "Claude Code isn't signed in. Open Settings > Claude to sign in.",
      // The run's own time limit: trying again would most likely hit it again, at the same cost.
      "Claude took longer than 20 minutes, so JobCairn stopped it.",
      "Claude finished but didn't write report.md. It wasn't allowed to: Write (notes.md).",
      "Set what you're looking for first: add a role.",
      "Claude didn't finish: credit balance is too low (timeout)",
      "",
    ]) expect(isTransientFailure(e), e).toBe(false);
  });
});
