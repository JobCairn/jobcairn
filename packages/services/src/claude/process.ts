// The process runner lives in @careeros/video (the lower package), so video tools and Claude Code share one copy.
import { CLAUDE_ENV_KEYS, cleanEnv as toolEnv } from "@careeros/video";

export {
  fakeRunner, killTree, nodeProcessRunner, untilAborted,
  type FakeRunner, type FakeScript, type ProcessRunner, type RunOptions, type RunResult,
} from "@careeros/video";

/** A tool's clean environment plus what Claude Code needs: its config folder and the person's proxy settings. */
export function cleanEnv(extra: Record<string, string>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return toolEnv(extra, source, CLAUDE_ENV_KEYS);
}
