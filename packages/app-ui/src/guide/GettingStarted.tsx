import { useState, type ReactNode } from "react";
import { Button, Card, Icon, Icons, Pill, PRODUCT_NAME, Text, SectionTitle } from "@careeros/brand";
import { setupState, type ChromeSearchState, type GuideState, type GuideStep, type SetupLive, type SetupStep } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { RunButton } from "../learn/RunButton";
import { useClaudeEngine } from "../claude";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { isExampleFolder } from "../tour/engine";
import "./guide.css";

export interface GettingStartedProps {
  /** Show even after it was hidden, and when every step is done (Learn's empty state does this). */
  always?: boolean;
  /**
   * Home: in a real workspace (not the example), show "Set up JobCairn" first (Claude, Chrome, profile, search
   * preferences, a first search and a first score) until each is done or skipped, then the first-week steps.
   */
  setup?: boolean;
  /** What "New topic" does. Defaults to opening Learn with the topic dialog. */
  onStartTopic?: () => void;
  /**
   * For Home and side panels: shows only the next step (about 220px tall at most) with a button to
   * expand the full list.
   */
  compact?: boolean;
}

const WORKSPACE = { kind: "workspace" } as const;

/** A step's reason when it can't be done yet, shown next to the disabled button so nobody has to guess. */
function Blocked({ label, why }: { label: string; why: string }) {
  return (
    <span className="guide-step__blocked">
      <Button size="sm" variant="secondary" disabled>{label}</Button>
      <Text role="body-sm" muted>{why}</Text>
    </span>
  );
}

/** Steps Claude does. Until Claude is set up, they offer the setup instead of a run that can't start. */
const NEEDS_CLAUDE = new Set<GuideStep["id"]>(["find_jobs", "score_job"]);
const setUpClaude = <Button size="sm" variant="primary" icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)}>Claude setup</Button>;

function stepView(step: GuideStep, s: GuideState, go: { startTopic(): void }, claudeReady: boolean): { title: string; body: string; action: ReactNode } {
  const v = stepText(step, s, go);
  if (claudeReady || step.done || !NEEDS_CLAUDE.has(step.id)) return v;
  return { ...v, body: `${v.body} This needs Claude, which takes a few minutes to set up.`, action: setUpClaude };
}

function stepText(step: GuideStep, s: GuideState, go: { startTopic(): void }): { title: string; body: string; action: ReactNode } {
  const f = s.facts;
  switch (step.id) {
    case "profile":
      if (step.done) return { title: "Add your profile and resume", body: "Your profile and resume are in. Claude uses them for every score and application.", action: null };
      return !f.profile
        ? { title: "Add your profile and resume", body: "Add your name, target roles and work rights. Then add your resume.", action: <Button size="sm" variant="primary" onClick={() => navigate({ screen: "settings", tab: "profile" })}>Open profile</Button> }
        : { title: "Add your resume", body: "Your profile is in. Drop your resume into the Drop box so Claude can use it.", action: <Button size="sm" variant="primary" onClick={() => navigate({ screen: "inbox" })}>Add resume</Button> };
    case "find_jobs":
      return step.done
        ? { title: "Find jobs", body: `${f.jobs} ${f.jobs === 1 ? "job" : "jobs"} saved so far.`, action: <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "jobs" })}>See jobs</Button> }
        : { title: "Find jobs", body: "Claude searches job sites for roles that match your profile and saves the good ones here.", action: <RunButton action="find_jobs" target={WORKSPACE} label="Find jobs" variant="primary" /> };
    case "score_job":
      if (step.done) return { title: "Score a job", body: `${f.scored} ${f.scored === 1 ? "job" : "jobs"} scored. Each score shows your fit and what's missing.`, action: null };
      return f.nextToScore
        ? { title: "Score a job", body: `Claude checks how well you fit ${f.nextToScore.title} at ${f.nextToScore.company_name}, and what's missing.`, action: <RunButton action="score_job" target={{ kind: "job", company_slug: f.nextToScore.company_slug, id: f.nextToScore.id }} label="Score" variant="primary" /> }
        : { title: "Score a job", body: "Claude checks how well you fit a job, and what's missing.", action: <Blocked label="Score" why="Find a job first." /> };
    case "prepare": {
      if (step.done) return { title: "Prepare your first application", body: "You've started an application. Nothing is sent without your OK.", action: <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "jobs", status: "Applying" })}>See applications</Button> };
      const j = f.nextToPrepare;
      return j
        ? { title: "Prepare your first application", body: `Claude tailors your resume and cover letter for ${j.title} at ${j.company_name}. You review everything first.`, action: <Button size="sm" variant="primary" onClick={() => navigate({ screen: "apply", slug: j.company_slug, id: j.id })}>Prepare application</Button> }
        : { title: "Prepare your first application", body: "Claude tailors your resume and cover letter for one job. You review everything first.", action: <Blocked label="Prepare application" why="Save a job you can apply for first." /> };
    }
    case "learn":
      return step.done
        ? { title: "Start a learning topic", body: "Your study guides are in Learn.", action: <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "learn" })}>Open Learn</Button> }
        : { title: "Start a learning topic", body: "Pick a skill the jobs ask for and Claude writes you a study guide.", action: <Button size="sm" variant="primary" onClick={go.startTopic}>New topic</Button> };
    case "email":
      if (!step.available) return { title: "Set up email", body: "Coming soon. Email arrives in a later update, and you don't need it to apply.", action: <Pill tone="neutral">Coming soon</Pill> };
      return step.done
        ? { title: "Set up email", body: "Gmail is connected. Job emails are filed under each job.", action: <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "mail" })}>Open Mail</Button> }
        : { title: "Set up email", body: "Connect Gmail to file job emails under each job and send replies after your OK. You don't need it to apply.", action: <Button size="sm" variant="secondary" onClick={() => navigate({ screen: "settings", tab: "connections", c: "email" })}>Connect Gmail</Button> };
  }
}

// -- Set up JobCairn ------------------------------------------------------------

const CHROME_SETTINGS = { screen: "settings", tab: "connections", c: "chrome" } as const;
const SEARCH_SETTINGS = { screen: "settings", tab: "search", section: "search-roles" } as const;

/** Chrome is connected for job search: the browser helper is in and Chrome's remote control is on. */
function chromeLive(c: ChromeSearchState | null | undefined): SetupLive["chrome"] {
  if (!c || !c.available) return undefined;
  return c.helper.found && c.remote.on;
}

function setupText(step: SetupStep, s: GuideState, go: { startTopic(): void }, claudeReady: boolean): { title: string; body: string; action: ReactNode } {
  // Profile, first search and first score read the same as in the first-week list.
  if (step.id === "profile" || step.id === "find_jobs" || step.id === "score_job") return stepView({ id: step.id, done: step.done, available: true }, s, go, claudeReady);
  switch (step.id) {
    case "claude":
      return step.done
        ? { title: "Connect Claude Code", body: "Connected. Claude finds, scores and writes with your own Claude plan.", action: null }
        : { title: "Connect Claude Code", body: "Claude does the searching, scoring and writing, using your own Claude plan. Takes a few minutes.", action: <Button size="sm" variant="primary" icon={Icons.ai} onClick={() => navigate(CLAUDE_SETTINGS)}>Connect Claude</Button> };
    case "chrome":
      return step.done
        ? { title: "Connect Chrome for job search", body: "Connected. Claude searches job boards in your own Chrome, where you're signed in.", action: null }
        : { title: "Connect Chrome for job search", body: "Claude searches LinkedIn, SEEK and other boards in your Chrome, where you're signed in. Optional: without it, Claude searches the web.", action: <Button size="sm" variant="primary" aria-label="Set up Chrome" onClick={() => navigate(CHROME_SETTINGS)}>Set up</Button> };
    case "search_prefs":
      return step.done
        ? { title: "Choose roles and places", body: "Claude searches for these. Change them any time in Settings, Search.", action: null }
        : { title: "Choose roles and places", body: "Tell Claude which jobs to search for and where you want to work.", action: <Button size="sm" variant="primary" aria-label="Set roles and places" onClick={() => navigate(SEARCH_SETTINGS)}>Set roles</Button> };
  }
}

interface SetupProps { s: GuideState; live: SetupLive; compact: boolean; go: { startTopic(): void }; reload(): void }

/**
 * "Set up JobCairn": what a new workspace needs before the first week, each step ticked from real state (Claude's
 * engine, the Chrome connection, the profile and resume, search preferences, saved and scored jobs). Optional steps
 * can be skipped; skips and Hide are saved in the workspace (`.careeros/guide.json`).
 */
function SetupChecklist({ s, live, compact, go, reload }: SetupProps) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [expanded, setExpanded] = useState(false);
  const v = setupState(s.facts, live, s.skipped);
  const steps = v.steps.filter((x) => x.available);
  const next = steps.find((x) => !x.done && !x.skipped)?.id;
  const hide = () => void run("guide-hide", () => bridge.guide.setDismissed(true).then(reload), "Checklist hidden. Bring it back from Settings, Appearance.");
  const skip = (id: SetupStep["id"], on: boolean) => void run(`skip-${id}`, () => bridge.guide.setSkipped(id, on).then(reload));
  const pct = Math.round((v.done / Math.max(1, v.total)) * 100);
  const shown = compact && !expanded ? steps.filter((x) => x.id === next) : steps;

  return (
    <Card className={compact ? "guide guide--compact" : "guide"} aria-labelledby="guide-title" data-tour="home-start">
      <header className="guide__head">
        <div className="guide__title">
          <SectionTitle icon={Icons.checklist} id="guide-title" title={`Set up ${PRODUCT_NAME}`} />
          <Text role="body-sm" muted>About 15 minutes. Each step ticks itself when it&apos;s done.</Text>
        </div>
        <div className="guide__meta">
          <span className="guide__count" aria-label={`${v.done} of ${v.total} setup steps done`}>
            <span className="t-numeric">{v.done}</span> of <span className="t-numeric">{v.total}</span> done
          </span>
          <Button size="sm" variant="ghost" icon={Icons.close} loading={busy === "guide-hide"} onClick={hide} aria-label="Hide the setup checklist">Hide checklist</Button>
        </div>
      </header>
      <div className="guide__meter" role="progressbar" aria-valuemin={0} aria-valuemax={v.total} aria-valuenow={v.done} aria-label="Setup progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="guide__steps" id="guide-steps">
        {shown.map((step) => {
          const i = steps.indexOf(step);
          const t = setupText(step, s, go, live.claude !== false);
          const state = step.done ? "done" : step.skipped ? "skipped" : step.id === next ? "next" : "todo";
          const action = step.skipped
            ? <><Pill tone="neutral">Skipped</Pill><Button size="sm" variant="ghost" loading={busy === `skip-${step.id}`} onClick={() => skip(step.id, false)}>Undo</Button></>
            : step.optional && !step.done
            ? <>{t.action}<Button size="sm" variant="ghost" loading={busy === `skip-${step.id}`} onClick={() => skip(step.id, true)} aria-label={`Skip ${t.title}`}>Skip</Button></>
            : t.action;
          return (
            <li key={step.id} className="guide-step" data-state={state} aria-current={state === "next" ? "step" : undefined}>
              <span className="guide-step__mark" aria-hidden="true">
                {step.done ? <Icon icon={Icons.check} size="sm" /> : <span className="t-numeric">{i + 1}</span>}
              </span>
              <div className="guide-step__text">
                <Text role="body" className="t-strong">
                  {t.title}
                  {step.optional ? <Text role="body-sm" muted as="span"> (optional)</Text> : null}
                  <span className="sr-only">{step.done ? " (done)" : step.skipped ? " (skipped)" : " (to do)"}</span>
                </Text>
                <Text role="body-sm" muted>{t.body}</Text>
              </div>
              <div className="guide-step__action">{action}</div>
            </li>
          );
        })}
      </ol>
      {compact ? (
        <div className="guide__more">
          <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls="guide-steps" onClick={() => setExpanded((x) => !x)}>
            {expanded ? "Show less" : "Show all"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// -- Getting started (the first week) -----------------------------------------

/**
 * First-run checklist, computed from what's really in the workspace. Each step ticks itself when its
 * data appears. Home mounts it as `<GettingStarted compact setup />`, which shows Set up JobCairn first in a real
 * workspace; hiding either is saved in the workspace.
 */
export function GettingStarted({ always = false, setup = false, onStartTopic, compact = false }: GettingStartedProps) {
  const bridge = useBridge();
  const st = useLoad((b) => b.guide.state(), [], ["home", "jobs", "learn", "settings", "inbox", "workspace", "mail"]);
  const { busy, run } = useAction();
  const [expanded, setExpanded] = useState(false);
  const engine = useClaudeEngine();
  const ws = useLoad((b) => (setup ? b.workspace.current() : Promise.resolve(null)), [setup], ["workspace"]);
  const chrome = useLoad((b) => (setup && b.chrome ? b.chrome.state(false) : Promise.resolve(null)), [setup], ["settings"]);
  // Unknown counts as ready, so nothing flickers while the engine is checked.
  const claudeReady = !engine.data || engine.data.ready;
  const s = st.data;
  if (!s) return null;
  const go = { startTopic: onStartTopic ?? (() => navigate({ screen: "learn", start: true })) };
  if (setup && !always) {
    // Wait for the first live checks, so a set-up workspace never flashes the setup list. A failed check counts as not done.
    const pending = (x: { data?: unknown; error: string | null }) => x.data === undefined && !x.error;
    if (pending(ws) || pending(engine) || pending(chrome)) return null;
    const live: SetupLive = { claude: engine.data?.ready === true, chrome: chromeLive(chrome.data) };
    if (!isExampleFolder(ws.data) && !setupState(s.facts, live, s.skipped).complete) {
      return s.dismissed ? null : <SetupChecklist s={s} live={live} compact={compact} go={go} reload={st.reload} />;
    }
  }
  const allDone = s.done === s.total;
  if (!always && (s.dismissed || allDone)) return null;
  const next = s.steps.find((x) => x.available && !x.done)?.id;
  const hide = () => void run("guide-hide", () => bridge.guide.setDismissed(true).then(() => st.reload()), "Checklist hidden.");
  const pct = Math.round((s.done / Math.max(1, s.total)) * 100);
  const collapsed = compact && !expanded;
  const shown = collapsed ? s.steps.filter((x) => x.id === next) : s.steps;

  return (
    <Card className={compact ? "guide guide--compact" : "guide"} aria-labelledby="guide-title" data-tour="home-start">
      <header className="guide__head">
        <div className="guide__title">
          <SectionTitle icon={Icons.checklist} id="guide-title" title={allDone ? "You're all set up" : "Getting started"} />
          {allDone ? null : <Text role="body-sm" muted>Your first week, step by step</Text>}
        </div>
        <div className="guide__meta">
          {/* Same words everywhere: "3 of 5 done". Email is listed as coming soon and isn't counted, so it has no number. */}
          <span className="guide__count" aria-label={`${s.done} of ${s.total} steps done`} title={s.steps.some((x) => !x.available) ? "Steps marked coming soon aren't counted." : undefined}>
            <span className="t-numeric">{s.done}</span> of <span className="t-numeric">{s.total}</span> done
          </span>
          {!always && !s.dismissed ? (
            <Button size="sm" variant="ghost" icon={Icons.close} loading={busy === "guide-hide"} onClick={hide} aria-label="Hide the getting started checklist">Hide</Button>
          ) : null}
        </div>
      </header>
      <div className="guide__meter" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.done} aria-label="Setup progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="guide__steps" id="guide-steps">
        {shown.map((step) => {
          // Numbered among the steps that count, so the numbers match "N of M done".
          const i = s.steps.filter((x) => x.available).indexOf(step);
          const v = stepView(step, s, go, claudeReady);
          const state = step.done ? "done" : !step.available ? "soon" : step.id === next ? "next" : "todo";
          return (
            <li key={step.id} className="guide-step" data-state={state} aria-current={state === "next" ? "step" : undefined}>
              <span className="guide-step__mark" aria-hidden="true">
                {step.done ? <Icon icon={Icons.check} size="sm" /> : state === "soon" ? <Icon icon={Icons.pending} size="sm" /> : <span className="t-numeric">{i + 1}</span>}
              </span>
              <div className="guide-step__text">
                <Text role="body" className="t-strong">
                  {v.title}
                  <span className="sr-only">{step.done ? " (done)" : state === "soon" ? " (coming soon)" : " (to do)"}</span>
                </Text>
                <Text role="body-sm" muted>{v.body}</Text>
              </div>
              <div className="guide-step__action">{v.action}</div>
            </li>
          );
        })}
      </ol>
      {compact ? (
        <div className="guide__more">
          <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls="guide-steps" onClick={() => setExpanded((x) => !x)}>
            {expanded ? "Show less" : "Show all"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
