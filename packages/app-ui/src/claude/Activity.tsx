import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Drawer, PRODUCT_NAME, Text, useToast } from "@careeros/brand";
import { isActiveRun, type ClaudeRunView } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { fmtDateTime } from "../format";
import { CLAUDE_SETTINGS, navigate, parseHash, toHash } from "../router";
import { isActionRun, resultLink, runLabel, runRoute } from "./activity-model";
import {
  allTasks, endedSince, isActiveTask, mergeHistory, notifyText, parseHistory, shouldNotify, toHistory,
  type HistoryEntry, type TaskEntry, type TaskStatus,
} from "./tasks-model";
import { ChromeRunStrip } from "../chrome/ChromeRun";
import { useWorkspaceKey } from "../workspaces/useWorkspaceKey";
import { RunCard } from "./RunCard";
import { formatElapsed, useElapsed } from "./run-helpers";
import { useClaudeRuns } from "./useClaudeRun";
import "./claude.css";

export interface ActivityApi {
  /** Open the Activity panel, optionally with one run expanded. */
  openDrawer(runId?: string): void;
  /** Show a run's details: its job's Activity tab when that job is on screen, else the Activity panel. */
  openRun(run: ClaudeRunView): void;
  /** What's running now (Claude runs and video jobs), for the sidebar line. */
  active: TaskEntry[];
  /** Finished tasks in this workspace, newest first (at most 50), for Home's "Just finished". */
  history: HistoryEntry[];
}

const ActivityContext = createContext<ActivityApi | null>(null);

/** The Activity panel's API, or null outside the app shell (tests that render one component). */
export function useActivity(): ActivityApi | null {
  return useContext(ActivityContext);
}

/** "Researching Acme Corp" style names for runs, from the job list (best effort). */
function useSubjects() {
  const jobs = useLoad((b) => b.jobs.list({ limit: 500, showIneligible: true }), [], ["jobs"]);
  return useMemo(() => {
    const jobsBy = new Map<string, string>();
    const companies = new Map<string, string>();
    for (const r of jobs.data?.rows ?? []) {
      jobsBy.set(`${r.company_slug}/${r.id}`, `${r.title} at ${r.company_name}`);
      companies.set(r.company_slug, r.company_name);
    }
    return (run: ClaudeRunView): string => {
      const t = run.target;
      if (!t) return "";
      if (t.kind === "job") return jobsBy.get(`${t.company_slug}/${t.id}`) ?? companies.get(t.company_slug) ?? "A job";
      if (t.kind === "company") return companies.get(t.company_slug) ?? "A company";
      if (t.kind === "topic") return t.company_slug && t.id ? `${t.label} · ${jobsBy.get(`${t.company_slug}/${t.id}`) ?? "a job"}` : t.label;
      if (t.kind === "resume_variant") return `Resume version: ${t.label}`;
      return "Your search";
    };
  }, [jobs.data]);
}

const NOTIFY_KEY = "careeros.notify";
/** OS notifications for long tasks: on unless switched off in Settings › Appearance. */
export function notificationsOn(): boolean {
  try { return localStorage.getItem(NOTIFY_KEY) !== "off"; } catch { return true; }
}
export function setNotificationsOn(on: boolean): void {
  try { localStorage.setItem(NOTIFY_KEY, on ? "on" : "off"); } catch { /* private mode: stays on */ }
}

const historyKey = (workspace: string) => `careeros.activity.history:${workspace}`;

/** Video jobs and the video types' names, for the Activity list. */
function useVideoTasks() {
  // Older or partial bridges (some tests) have no video group: then there are just no video jobs.
  const runs = useLoad((b) => (typeof b.video?.runs === "function" ? b.video.runs() : Promise.resolve([])), [], ["video"]);
  const types = useLoad((b) => (typeof b.video?.types === "function" ? b.video.types("all") : Promise.resolve(null)), [], ["video"]);
  const label = useCallback((id: string) => types.data?.types?.find((t) => t.id === id)?.label, [types.data]);
  return { runs: runs.data, label };
}

/**
 * When a task ends: a toast with a link to its result (unless you're already there), an OS notification when it
 * took over 30 seconds and the window isn't in front (if switched on), and a line in History.
 */
function useTaskEnds(tasks: TaskEntry[] | null, open: (t: TaskEntry) => void, addHistory: (e: HistoryEntry[]) => void): void {
  const toast = useToast();
  const seen = useRef<Map<string, TaskStatus> | null>(null);
  useEffect(() => {
    if (!tasks) return;
    const before = seen.current;
    seen.current = new Map(tasks.map((t) => [t.id, t.status]));
    if (!before) return;
    const ended = endedSince(before, tasks);
    if (!ended.length) return;
    const now = new Date();
    addHistory(ended.filter((t) => !t.quiet).map((t) => toHistory(t, now.toISOString())));
    for (const t of ended) {
      if (t.quiet) continue;
      const here = !!t.open.to && toHash(t.open.to) === toHash(parseHash(window.location.hash));
      const text = t.status === "done" ? t.done : t.status === "review" ? t.done : t.status === "failed" ? (t.kind === "video" ? `${t.label}. ${t.done}` : `Claude didn't finish: ${t.label}`) : `Stopped: ${t.label}`;
      const tone = t.status === "done" || t.status === "review" ? "success" : t.status === "failed" ? "danger" : "neutral";
      toast({ tone, text, ...(here ? {} : { action: { label: t.open.label, ariaLabel: `${t.open.label}: ${t.label}`, onClick: () => open(t) } }) });
      if (typeof window.Notification === "function" && shouldNotify(t, { focused: document.hasFocus(), enabled: notificationsOn(), now: now.getTime() })) {
        try {
          const n = new window.Notification(notifyText(t, t.done).title, { body: notifyText(t, t.done).body, silent: false });
          n.onclick = () => { window.focus(); open(t); };
        } catch { /* notifications unavailable: the toast is enough */ }
      }
    }
  }, [tasks, toast, open, addHistory]);
}

/**
 * Holds the global Activity panel. Claude runs and video jobs live in the main process and keep going while you
 * move between screens, so any screen can open this panel to follow, open or cancel them. Mounted once by the Shell.
 */
export function ClaudeActivityProvider({ children }: { children: ReactNode }) {
  const runs = useClaudeRuns();
  const videos = useVideoTasks();
  const tasks = useMemo(() => (runs.data ? allTasks(runs.data, videos.runs ?? [], videos.label) : null), [runs.data, videos.runs, videos.label]);
  const workspace = useWorkspaceKey();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (!workspace) return;
    try { setHistory(parseHistory(localStorage.getItem(historyKey(workspace)))); } catch { setHistory([]); }
  }, [workspace]);
  const addHistory = useCallback((add: HistoryEntry[]) => {
    setHistory((prev) => {
      const next = mergeHistory(prev, add);
      try { if (workspace) localStorage.setItem(historyKey(workspace), JSON.stringify(next)); } catch { /* storage full or off */ }
      return next;
    });
  }, [workspace]);
  const [state, setState] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null });
  const openDrawer = useCallback((runId?: string) => setState({ open: true, focus: runId ?? null }), []);
  const openRun = useCallback((run: ClaudeRunView) => {
    const r = runRoute(run);
    const here = parseHash(window.location.hash);
    if (r && r.screen === "job" && here.screen === "job" && here.slug === r.slug && here.id === r.id) { navigate(r); return; }
    setState({ open: true, focus: run.id });
  }, []);
  // From a toast or notification: go to where the result is, or open the panel when it has no screen of its own.
  const openTask = useCallback((t: TaskEntry) => {
    if (t.open.to) navigate(t.open.to); else setState({ open: true, focus: t.id.replace(/^[a-z]+:/, "") });
  }, []);
  useTaskEnds(tasks, openTask, addHistory);
  const active = useMemo(() => (tasks ?? []).filter(isActiveTask), [tasks]);
  const api = useMemo(() => ({ openDrawer, openRun, active, history }), [openDrawer, openRun, active, history]);
  return (
    <ActivityContext.Provider value={api}>
      {children}
      <ActivityDrawer open={state.open} focus={state.focus} runs={runs.data ?? []} videos={(tasks ?? []).filter((t) => t.kind === "video")} history={history}
        onClose={() => setState((s) => ({ ...s, open: false }))} />
    </ActivityContext.Provider>
  );
}

function ActivityRow({ run, subject, expanded, onToggle, onOpen, openLabel }: { run: ClaudeRunView; subject: string; expanded: boolean; onToggle: () => void; onOpen: (() => void) | null; openLabel: string }) {
  const bridge = useBridge();
  const toast = useToast();
  const elapsed = useElapsed(run);
  const active = isActiveRun(run.status);
  const label = runLabel(run);
  const status = run.status === "running" ? "Running" : run.status === "queued" ? "Waiting" : run.status === "succeeded" ? "Done" : run.status === "cancelled" ? "Stopped" : "Didn't finish";
  const when = active ? formatElapsed(elapsed) : fmtDateTime(run.ended_at);
  const cancel = () => void bridge.claude.cancel(run.id).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  const retry = () => {
    if (!isActionRun(run)) return;
    void bridge.claude.run(run.action, run.target, {}).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  };
  return (
    <li className={`act-row act-row--${run.status}`}>
      <div className="act-row__line">
        <button type="button" className="act-row__main" aria-expanded={expanded} onClick={onToggle} aria-label={`${label}, ${subject}: ${status}. ${expanded ? "Hide" : "Show"} details`}>
          <span className={`act-row__dot act-row__dot--${run.status}`} aria-hidden="true" />
          <span className="act-row__text">
            <span className="act-row__label">{label}</span>
            <span className="act-row__sub">{subject}</span>
          </span>
          <span className="act-row__meta">{status}{when ? ` · ${when}` : ""}</span>
        </button>
        {onOpen ? <Button size="sm" variant="ghost" aria-label={`${openLabel}: ${label}, ${subject}`} onClick={onOpen}>{openLabel}</Button> : null}
        {active ? <Button size="sm" variant="ghost" aria-label={`Cancel: ${label}, ${subject}`} onClick={cancel}>Cancel</Button> : null}
      </div>
      {expanded && isActionRun(run) ? (
        <RunCard run={run} action={run.action} target={run.target} compact stepsOpen cancelable={false} onCancel={cancel} onRetry={retry} />
      ) : null}
    </li>
  );
}

/** A video job in the panel: what it is, where it's up to, Open and (while it runs) Cancel. */
function VideoActivityRow({ task, onOpen }: { task: TaskEntry; onOpen: () => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const active = isActiveTask(task);
  const status = task.status === "running" ? "Running" : task.status === "queued" ? "Waiting" : task.status === "review" ? "Your turn"
    : task.status === "done" ? "Done" : task.status === "stopped" ? "Stopped" : "Didn't finish";
  const runId = task.id.replace(/^video:/, "");
  const cancel = () => void bridge.video.cancel(runId).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  return (
    <li className={`act-row act-row--${active ? "running" : task.status === "failed" ? "failed" : "succeeded"}`}>
      <div className="act-row__line">
        <div className="act-row__main act-row__main--static">
          <span className={`act-row__dot act-row__dot--${active ? "running" : task.status === "failed" ? "failed" : "succeeded"}`} aria-hidden="true" />
          <span className="act-row__text">
            <span className="act-row__label">{task.label}</span>
            <span className="act-row__sub">{task.stage ?? task.verb}</span>
          </span>
          <span className="act-row__meta">{status}</span>
        </div>
        <Button size="sm" variant="ghost" aria-label={`${task.open.label}: ${task.label}`} onClick={onOpen}>{task.open.label}</Button>
        {active ? <Button size="sm" variant="ghost" aria-label={`Cancel: ${task.label}`} onClick={cancel}>Cancel</Button> : null}
      </div>
    </li>
  );
}

const HISTORY_STATUS: Record<TaskStatus, string> = { queued: "Waiting", running: "Running", review: "Script ready for your review", done: "Done", failed: "Didn't finish", stopped: "Stopped" };

/**
 * The global Activity panel: what's running (Claude runs, video jobs, a search in your Chrome), what finished this
 * session, and History: the last 50 finished tasks in this workspace, kept between launches.
 */
export function ActivityDrawer({ open, focus, runs, videos = [], history = [], onClose }: {
  open: boolean; focus: string | null; runs: ClaudeRunView[]; videos?: TaskEntry[]; history?: HistoryEntry[]; onClose: () => void;
}) {
  const subjectOf = useSubjects();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { if (open) setExpanded(new Set(focus ? [focus] : [])); }, [open, focus]);
  const shown = runs.filter((r) => r.action !== "video_script");
  const active = shown.filter((r) => isActiveRun(r.status));
  const done = shown.filter((r) => !isActiveRun(r.status)).slice(0, 20);
  const videoActive = videos.filter(isActiveTask);
  const videoDone = videos.filter((t) => !isActiveTask(t));
  const live = new Set([...shown.map((r) => `claude:${r.id}`), ...videos.map((t) => t.id)]);
  const past = history.filter((h) => !live.has(h.id));
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const go = (to: Parameters<typeof navigate>[0]) => { onClose(); navigate(to); };
  const row = (r: ClaudeRunView) => {
    const { label, to } = resultLink(r);
    return <ActivityRow key={r.id} run={r} subject={subjectOf(r)} expanded={expanded.has(r.id)} onToggle={() => toggle(r.id)} openLabel={label}
      onOpen={to ? () => go(to) : null} />;
  };
  const videoRow = (t: TaskEntry) => <VideoActivityRow key={t.id} task={t} onOpen={() => { if (t.open.to) go(t.open.to); }} />;
  const nothing = !shown.length && !videos.length && !past.length;
  const runningCount = active.length + videoActive.length;
  return (
    <Drawer open={open} onClose={onClose} title="Claude activity"
      subtitle={`Tasks keep going when you switch screens. They stop if you quit ${PRODUCT_NAME}.`}>
      {nothing ? (
        <div className="stack">
          <Text role="body" muted>Nothing has run yet. When you ask Claude for something, its progress shows here.</Text>
          <div><Button size="sm" variant="ghost" onClick={() => go(CLAUDE_SETTINGS)}>Claude setup</Button></div>
        </div>
      ) : (
        <>
          <section aria-label="Running" className="act-group">
            <Text role="label" as="h3" className="act-group__title">Running ({runningCount})</Text>
            <ChromeRunStrip />
            {runningCount ? <ul className="list-plain act-list">{active.map(row)}{videoActive.map(videoRow)}</ul> : <Text role="body-sm" muted>Nothing is running.</Text>}
          </section>
          {done.length || videoDone.length ? (
            <section aria-label="Earlier" className="act-group">
              <Text role="label" as="h3" className="act-group__title">Earlier</Text>
              <ul className="list-plain act-list">{done.map(row)}{videoDone.map(videoRow)}</ul>
            </section>
          ) : null}
          {past.length ? (
            <section aria-label="History" className="act-group">
              <Text role="label" as="h3" className="act-group__title">History</Text>
              <ul className="list-plain act-list act-list--history">
                {past.map((h) => (
                  <li key={h.id} className="act-hist">
                    <span className="act-hist__label">{h.label}</span>
                    <span className="act-hist__meta">{HISTORY_STATUS[h.status]} · {fmtDateTime(h.ended_at)}</span>
                    {h.open.to ? <Button size="sm" variant="ghost" aria-label={`${h.open.label}: ${h.label}`} onClick={() => go(h.open.to!)}>{h.open.label}</Button> : <span />}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </Drawer>
  );
}
