export type Run = (cmd: string, args: string[]) => Promise<unknown>;

/** Opens the Claude desktop app if we know how on this platform. */
export async function openClaudeDesktop(platform: NodeJS.Platform, run: Run): Promise<boolean> {
  if (platform !== "darwin") return false;
  try { await run("open", ["-a", "Claude"]); return true; } catch { return false; }
}
