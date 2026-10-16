import { useFileViewer } from "../viewer";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Icon, Icons, Pill, Text, useToast } from "@careeros/brand";
import { ACTIONS, claudeWrites, type ActionId, type ActionTarget, type ChangeArea } from "@careeros/contract";
import { RunChip, useActivity, useClaudeRun } from "../claude";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { ComposeButton } from "../composer";
import { MakeVideoButton, VIDEO_ACTION_TYPES } from "./MakeVideo";

/** Areas whose changes can make an action's outputs appear (the watcher maps files to these). */
export const ACTION_AREAS: ChangeArea[] = ["jobs", "learn", "searches"];
export const WORKSPACE: ActionTarget = { kind: "workspace" };

export interface ActionButtonProps {
  action: ActionId;
  target: ActionTarget;
  /** Button text, two words at most; defaults to the catalogue's short button label. */
  label?: string;
  /** Accessible name when several buttons share a label (for example one per skill gap). */
  ariaLabel?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /** Runs first, for example Apply's own prepare step. If it throws, Claude isn't asked. */
  before?: () => Promise<unknown>;
  /**
   * Asks Claude once on its own, when the action is idle and nothing is running (the Jobs list's one-click Score).
   * Never when it's ready, blocked or pending. When Claude isn't set up, the usual setup line shows instead.
   */
  autoStart?: boolean;
}

/** Says what happened when a followed run ends, naming the result. */
function useRunToast(run: ReturnType<typeof useClaudeRun>["run"], done: string, text: string): void {
  const toast = useToast();
  // Inside the app shell the Activity provider toasts every finished run (with "Open"), so stay quiet here.
  const global = !!useActivity();
  const seen = useRef<{ id: string; active: boolean } | null>(null);
  const status = run?.status;
  useEffect(() => {
    if (!run) return;
    const active = run.status === "queued" || run.status === "running";
    const before = seen.current;
    seen.current = { id: run.id, active };
    if (global || !before || before.id !== run.id || !before.active || active) return;
    if (run.status === "succeeded") toast({ tone: "success", text: run.stray.length ? `${done}. Check the warning below.` : done });
    else if (run.status === "failed") toast({ tone: "danger", text: `Claude didn't finish: ${text}` });
    else toast({ tone: "neutral", text: `Stopped: ${text}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, status]);
}

/**
 * One way to ask Claude for anything: runs the person's own Claude Code in the background (the engine, spec
 * 2026-10-10). While it runs, a one-line <RunChip> ("Researching · 0:20 · Cancel") takes the button's place, so the
 * page never moves; the steps and files are one click away (the job's Activity tab or the Activity panel). Then
 * it shows the action's status from its files: idle, ready, or blocked by a prerequisite (with one click to start
 * that first). When Claude isn't set up yet, one line says so and links to the setup.
 */
export function ActionButton(props: ActionButtonProps) {
  const def = ACTIONS[props.action];
  const typeId = VIDEO_ACTION_TYPES[props.action];
  // Every video goes through the one Make video dialog (Task 23): it shows the type, length, files and tools.
  if (def.group === "video" && typeId) {
    return <MakeVideoButton target={props.target} typeId={typeId} label={props.label ?? def.button} title={def.label} ariaLabel={props.ariaLabel} variant={props.variant} size={props.size} />;
  }
  return <ClaudeActionButton {...props} />;
}

/** Actions you run again and again: when one is done, its own button stays (not "Redo") next to its last result. */
const REPEATABLE: ReadonlySet<string> = new Set(["find_jobs", "chrome_check", "check_recruiters"]);

function ClaudeActionButton({ action, target, label, ariaLabel, variant = "secondary", size = "sm", before, autoStart }: ActionButtonProps) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const claude = useClaudeRun(action, target);
  const [asked, setAsked] = useState(false);
  const def = ACTIONS[action];
  const text = label ?? def.button;
  const name = ariaLabel ?? text;
  const key = `${action}:${JSON.stringify(target)}`;
  const st = useLoad((b) => b.claude.status(action, target), [key], [...ACTION_AREAS, "claude"]);
  const whyId = useId();
  useRunToast(claude.run, def.done, text);

  const ask = () => run(key, async () => {
    setAsked(true);
    if (!claude.ready) return undefined;
    if (before) await before();
    const r = await claude.start();
    st.reload();
    return r;
  });
  const autoed = useRef(false);
  const idle = st.data?.status === "idle" && !!claude.engine && !claude.running && busy !== key;
  useEffect(() => {
    if (!autoStart || autoed.current || !idle) return;
    autoed.current = true;
    void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, idle]);
  const reveal = (rel: string) => void bridge.files.reveal(rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  // A ready action's files open in the app's own viewer; Finder is the small folder icon beside it.
  const made = (st.data?.outputs ?? []).filter((o) => o.exists);
  const viewer = useFileViewer(made.map((o) => ({ rel: o.path, title: o.path.split("/").pop() })));

  const s = st.data;
  if (!s) return st.error ? <Text role="body-sm" muted>{text}: {st.error}</Text> : <span className="action" aria-busy="true" />;
  const working = busy === key || claude.running;
  // Weekly recaps are rendered by the video lane's template, never by Claude.
  // Carry: the video lane wires this to its own "Make video" flow.
  if (!claudeWrites(action) && s.status !== "ready") {
    return (
      <div className="action" data-status="unavailable">
        <Blocked size={size} variant={variant} name={name} text={text} why="Weekly recaps arrive with the video maker." id={whyId} />
      </div>
    );
  }
  const r = claude.run;
  // The chip replaces the buttons while a run is going, and after one this screen started fails or stops.
  const chip = r && (claude.running || (asked && (r.status === "failed" || r.status === "cancelled")))
    ? <RunChip run={r} onCancel={() => void claude.cancel()} onRetry={() => void ask()} retrying={busy === key} /> : null;
  const setup = asked && !claude.running && claude.engine && !claude.ready;
  return (
    <div className="action" data-status={claude.running ? "running" : s.status}>
      {chip ?? (
        <>
          {s.status === "blocked" ? (
            <>
              <Blocked size={size} variant={variant} name={name} text={text} id={whyId}
                why={`Do ${s.blockedBy.map((b) => `“${ACTIONS[b].button}”`).join(" and ")} first.`} />
              {/* One click to set it up: run the first missing step (HD-07 ruling). */}
              <StartWith action={s.blockedBy[0]!} target={target} onDone={() => st.reload()} />
            </>
          ) : null}
          {s.status === "idle" || s.status === "pending" ? (
            <>
              {s.status === "pending" ? <Pill tone="accent" title="You copied the prompt to use in Claude yourself">Prompt copied</Pill> : null}
              <Button size={size} variant={variant} icon={Icons.ai} loading={working} aria-label={name} title={def.label} onClick={() => void ask()}>{text}</Button>
              <ComposeButton action={action} target={target} name={name} />
            </>
          ) : null}
          {s.status === "ready" ? (
            <>
              {/* An action you run again and again (Find jobs) keeps its own button: its last report is one click away. */}
              {REPEATABLE.has(action)
                ? <Button size={size} variant={variant} icon={Icons.ai} loading={working} aria-label={name} title={def.label} onClick={() => void ask()}>{text}</Button>
                : <Pill tone="success">{def.done}</Pill>}
              {made[0] ? <Button size="sm" variant="ghost" icon={Icons.file} aria-label={`View files: ${name}`} title="Open in the app" onClick={() => viewer.open(made[0]!.path)}>{REPEATABLE.has(action) ? "Last report" : "View"}</Button> : null}
              <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`Show files: ${name}`} title="Show in folder" onClick={() => reveal(s.folder)} />
              {claudeWrites(action) && !REPEATABLE.has(action) ? <Button size="sm" variant="ghost" icon={Icons.redo} loading={working} aria-label={`Redo: ${name}`} onClick={() => void ask()}>Redo</Button> : null}
              <ComposeButton action={action} target={target} name={name} />
            </>
          ) : null}
        </>
      )}
      {setup ? <SetupLine action={action} target={target} /> : null}
      {viewer.element}
      {st.error ? <Text role="body-sm" muted>{st.error}</Text> : null}
    </div>
  );
}

/**
 * One line, never a panel: Claude isn't set up yet, with the way to set it up and the prompt as a fallback. When
 * copying fails, the prompt opens in a dialog rather than pushing the page down.
 */
function SetupLine({ action, target }: { action: ActionId; target: ActionTarget }) {
  const bridge = useBridge();
  const toast = useToast();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = ACTIONS[action].label;
  const copy = async () => {
    setBusy(true);
    try {
      const r = await bridge.claude.prepare(action, target, false);
      if (r.copied) toast({ tone: "success", text: "Prompt copied. Paste it into Claude." });
      else setPrompt(r.prompt);
    } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <span className="action__why">
      Claude isn't set up yet.
      <Button size="sm" variant="ghost" icon={Icons.settings} onClick={() => navigate(CLAUDE_SETTINGS)}>Claude setup</Button>
      {claudeWrites(action) ? <Button size="sm" variant="ghost" loading={busy} aria-label={`Copy prompt: ${label}`} title="Copy the prompt to paste into Claude yourself" onClick={() => void copy()}>Copy prompt</Button> : null}
      <Dialog open={prompt !== null} onClose={() => setPrompt(null)} title="Copying didn't work" actions={<Button onClick={() => setPrompt(null)}>Close</Button>}>
        <Text role="body-sm" muted>Select the prompt below and copy it into Claude yourself.</Text>
        <pre className="markdown crun__prompt">{prompt}</pre>
      </Dialog>
    </span>
  );
}

/**
 * The prerequisite's own short button ("Score"), titled "Start with …": runs the missing step with Claude Code and follows it here. When Claude isn't set
 * up, says so and links to Settings > Claude instead.
 */
export function StartWith({ action, target, onDone }: { action: ActionId; target: ActionTarget; onDone: () => void }) {
  const claude = useClaudeRun(action, target);
  const { busy, run } = useAction();
  const [asked, setAsked] = useState(false);
  const label = ACTIONS[action].label;
  const key = `setup:${action}:${JSON.stringify(target)}`;
  useRunToast(claude.run, ACTIONS[action].done, label);
  const status = claude.run?.status;
  useEffect(() => { if (status === "succeeded") onDone(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);
  if (claude.engine && !claude.ready) return <SetupLine action={action} target={target} />;
  const r = claude.run;
  // Only the place that started the run shows its chip, so one run never shows twice on a page.
  if (r && asked && (claude.running || r.status === "failed" || r.status === "cancelled")) {
    return <RunChip run={r} onCancel={() => void claude.cancel()} onRetry={() => void run(key, async () => { await claude.start(); })} />;
  }
  return (
    <Button size="sm" variant="ghost" icon={Icons.ai} loading={busy === key || claude.running}
      disabled={!claude.engine} title={!claude.engine ? "Checking Claude…" : claude.running ? `Claude is already doing “${label}”.` : `Start with “${label}”`}
      onClick={() => void run(key, async () => { setAsked(true); await claude.start(); })}>{ACTIONS[action].button}</Button>
  );
}

/**
 * A disabled action that says why, in readable contrast: the reason sits beside the button as helper
 * text (tied by aria-describedby) and repeats in the button's tooltip.
 */
function Blocked({ size, variant, name, text, why, id }: { size: "sm" | "md"; variant: "primary" | "secondary" | "ghost"; name: string; text: string; why: string; id: string }) {
  return (
    <>
      <Button size={size} variant={variant === "primary" ? "secondary" : variant} icon={Icons.locked} disabled aria-label={name} aria-describedby={id} title={why}>{text}</Button>
      <span id={id} className="action__why"><Icon icon={Icons.info} size="sm" />{why}</span>
    </>
  );
}

