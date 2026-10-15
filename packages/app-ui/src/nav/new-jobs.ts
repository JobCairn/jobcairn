import { useEffect, useState } from "react";
import { useLoad } from "../bridge-context";
import { newRows, readSeen } from "../jobs/seen";
import { useWorkspaceKey } from "../workspaces/useWorkspaceKey";

/**
 * How many jobs were found since you last looked at Jobs: the same baseline as the Jobs list's "N new" chip (the
 * newest job on screen when you left). Re-read whenever the screen changes, because leaving Jobs moves it on.
 * Zero (or no baseline yet) means no badge.
 */
export function useNewJobsCount(screen: string): number {
  const workspace = useWorkspaceKey();
  const jobs = useLoad((b) => b.jobs.list({ limit: 500 }), [], ["jobs", "settings"]);
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => { setSeen(workspace ? readSeen(workspace) : null); }, [workspace, screen]);
  return jobs.data ? newRows(jobs.data.rows, seen).length : 0;
}
