import { useLoad } from "../bridge-context";

/**
 * The open workspace's key, for things kept per workspace on this computer (Activity history, which jobs you've
 * seen). "default" when the shell can't say; null while it's being read.
 */
export function useWorkspaceKey(): string | null {
  const recent = useLoad((b) => (typeof b.workspace?.recent === "function" ? b.workspace.recent() : Promise.resolve([])), [], ["workspace"]);
  if (recent.error) return "default";
  if (!recent.data) return null;
  return recent.data.find((w) => w.current)?.key ?? "default";
}
