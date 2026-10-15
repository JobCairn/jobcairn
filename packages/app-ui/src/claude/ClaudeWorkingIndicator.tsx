import { Icon, ServiceMarks, type IconGlyph } from "@careeros/brand";
import { isActiveRun } from "@careeros/contract";
import { useClaudeEngine, useClaudeRuns } from "./useClaudeRun";
import { useActivity } from "./Activity";
import { sidebarLine } from "./tasks-model";
import { CLAUDE_SETTINGS, navigate } from "../router";
import "./claude.css";

/** A footer status dot: green ready, amber busy, grey off, red needs attention. */
export type StatusTone = "ok" | "busy" | "off" | "alert";

/**
 * A status icon for the sidebar footer: the service's icon with a small dot in its corner, and a turning ring while
 * it's busy. The full status ("Claude · Making a video") is the tooltip and the accessible name.
 */
export function StatusIcon({ icon, tone, status, action, onClick, live }: {
  icon: IconGlyph; tone: StatusTone; status: string; action: string; onClick: () => void; live?: boolean;
}) {
  return (
    <button type="button" className="rail-stat" aria-label={`${status}. ${action}`} aria-live={live ? "polite" : undefined}
      data-tip={status} data-hint={status} data-tone={tone} onClick={onClick}>
      <Icon icon={icon} size="sm" />
      {tone === "busy" ? <span className="rail-stat__ring" aria-hidden="true" /> : null}
      <span className={`rail-stat__dot rail-stat__dot--${tone}`} aria-hidden="true" />
    </button>
  );
}

/**
 * The sidebar footer's Claude icon. Ready: a green dot ("Claude · ready"). While work is going: an amber dot and a
 * turning ring, naming the task ("Claude · Making a video") or counting several ("Claude · 2 running"). Clicking it
 * opens the Activity panel; when Claude isn't set up yet it opens Settings > Connections > Claude instead.
 */
export function ClaudeWorkingIndicator() {
  const engine = useClaudeEngine();
  const runs = useClaudeRuns();
  const activity = useActivity();
  // Inside the shell, the Activity provider counts Claude runs and video jobs; alone, just Claude runs.
  const tasks = activity?.active ?? null;
  const active = tasks ? tasks.length : (runs.data ?? []).filter((r) => isActiveRun(r.status)).length;
  const e = engine.data;
  const idle = !e ? (engine.error ? "Claude · can't check" : "Claude · checking…") : e.ready ? "Claude · ready" : "Claude · set up needed";
  const status = active ? (tasks ? sidebarLine(tasks) : `Claude · ${active} running`) : idle;
  const tone: StatusTone = active ? "busy" : !e ? (engine.error ? "alert" : "off") : e.ready ? "ok" : "off";
  const toActivity = !!activity && (active > 0 || !!e?.ready);
  return (
    <StatusIcon icon={ServiceMarks.claude} tone={tone} status={status} live
      action={toActivity ? "Show activity" : "Open Claude settings"}
      onClick={() => (toActivity ? activity.openDrawer() : navigate(CLAUDE_SETTINGS))} />
  );
}
