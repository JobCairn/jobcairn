import { useEffect, useId, useMemo, useState } from "react";
import { Button, Icon, Pill, Text, Textarea, useToast, PRODUCT_NAME } from "@careeros/brand";
import {
  ACTIONS, actionPaths, buildActionPrompt, claudeWrites, makeNonce, NOTE_MAX, noteProblems, optionsFor, outputNames, ownTarget, SAVED_SEARCH_OPTIONS,
  type ActionId, type ActionTarget, type ClaudeRunView, type ComposeView, type OptionValue,
} from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import type { ChangeArea } from "@careeros/contract";
import { Loading } from "../components/States";
import { ClaudeRunPanel, useClaudeRun } from "../claude";
import { AllowHint, ComposerBoards } from "../chrome";
import { LookingFor, type LookingForState } from "../findjobs/LookingFor";
import { DescribeSearch, describedPatch, NOTHING_DESCRIBED, type Described } from "../findjobs/DescribeSearch";
import { RepeatSearch } from "../findjobs/RepeatSearch";
import type { BoardId } from "@careeros/contract";
import { AiIcon, CopyIcon, LockIcon } from "./icons";
import { ALWAYS_ON, DEFAULT_EXAMPLES, fileChips, NOTE_EXAMPLES, requestSentence } from "./labels";
import { OptionField } from "./OptionField";
import { PromptView } from "./PromptView";
import "./composer.css";

/** Areas whose changes can make the action's files appear (same as ActionButton). */
const ACTION_AREAS: ChangeArea[] = ["jobs", "learn", "searches"];

export interface RequestComposerProps {
  action: ActionId;
  target: ActionTarget;
  /** The primary button's text. Defaults to the action's short button label. */
  label?: string;
  /** Runs before Claude starts (Apply's own prepare step). If it throws, Claude isn't started. */
  before?: () => Promise<unknown>;
  /** Called with the run once Claude Code has started it. */
  onStarted?: (run: ClaudeRunView) => void;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Ask Claude for something, with a say in how: a few fixed options per action, an "anything else?" note, the rules
 * that are always on, the files Claude will create, and the full prompt for anyone who wants to read it or run it
 * themselves. The prompt is built by the contract from these choices; nothing typed here can change the rules or files.
 */
export function RequestComposer({ action, target, label = ACTIONS[action].button, before, onStarted }: RequestComposerProps) {
  const key = `${action}:${JSON.stringify(target)}`;
  const cv = useLoad((b) => b.claude.compose(action, target), [key], []);
  if (!claudeWrites(action)) return <Text role="body" muted>{requestSentence(action, {})}</Text>;
  if (cv.error && !cv.data) return <Text role="body" muted>{cv.error}</Text>;
  if (!cv.data) return <Loading />;
  return <ComposerForm key={key} action={action} target={target} label={label} before={before} onStarted={onStarted} view={cv.data} />;
}

function ComposerForm({ action, target, label, before, onStarted, view }: Required<Pick<RequestComposerProps, "action" | "target" | "label">> & Pick<RequestComposerProps, "before" | "onStarted"> & { view: ComposeView }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run: act } = useAction();
  const claude = useClaudeRun(action, target);
  const [options, setOptions] = useState<Record<string, OptionValue>>(view.options);
  const [note, setNote] = useState("");
  // Search in my Chrome (lane S): the boards for this find-jobs run only. Null: all ticked boards (or the web).
  const [boards, setBoards] = useState<BoardId[] | null>(null);
  // Find jobs: why it can't start yet (no role or place), and the saved breadth, sponsorship and jobs choices.
  const [looking, setLooking] = useState<LookingForState | null>(null);
  // Find jobs: "Describe the jobs you want", for this search only (sent as the run's own search choices).
  const [described, setDescribed] = useState<Described>(NOTHING_DESCRIBED);
  const lookingWhy = looking?.why ?? "";
  const [showPrompt, setShowPrompt] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const status = useLoad((b) => b.claude.status(action, target), [action, JSON.stringify(target)], ACTION_AREAS);
  useEffect(() => setOptions(view.options), [view]);
  // Find jobs: breadth, sponsorship-only and jobs to find are saved search settings (the chips edit them), so the prompt preview
  // and the run use the saved values. Main reads the same saved values again when it starts the run.
  useEffect(() => {
    if (!looking) return;
    setOptions((cur) => ({ ...cur, breadth: looking.breadth, max_jobs: looking.max_jobs, ...("sponsor_only" in cur ? { sponsor_only: looking.sponsor_only } : {}) }));
  }, [looking?.breadth, looking?.sponsor_only, looking?.max_jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = ownTarget(action, target);
  // Sponsorship options follow the candidate's work-rights status. Slug options (ids the app fills in) aren't shown.
  const allDefs = optionsFor(action, view.info.work_rights).filter((o) => o.kind !== "slug");
  // Find jobs: breadth, "Only ads that offer sponsorship" and jobs to find are saved search settings, shown as chips
  // in "What you're looking for", not here.
  const sponsorOffered = action === "find_jobs" && allDefs.some((o) => o.key === "sponsor_only");
  const defs = action === "find_jobs" ? allDefs.filter((o) => !(SAVED_SEARCH_OPTIONS as readonly string[]).includes(o.key)) : allDefs;
  const { outputs, extras } = actionPaths(action, t, view.info);
  // With the cover letter off, Claude writes only a placeholder there: no chip for it.
  const shown = action === "tailor_application" && options.cover_letter === false ? outputs.filter((o) => !o.endsWith("/cover-letter.md")) : outputs;
  const files = fileChips(shown, extras);
  const own = outputNames(action);
  const topic = target.kind === "topic" || target.kind === "resume_variant" || target.kind === "research" ? target.label : "";
  const problems = noteProblems(note, own);
  const length = Array.from(note).length;
  // One nonce for the on-screen preview; every real run or copy gets a fresh one.
  const previewNonce = useMemo(makeNonce, []);
  const compose = (nonce?: string) => buildActionPrompt(action, t, view.info, { options, note }, nonce);
  const built = useMemo((): { prompt: string; error: "" } | { prompt: null; error: string } => {
    try { return { prompt: compose(previewNonce), error: "" }; } catch (e) { return { prompt: null, error: (e as Error).message }; }
  }, [options, note, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = built.prompt;

  const blockedBy = status.data?.status === "blocked" ? status.data.blockedBy.map((r) => ACTIONS[r].label) : [];
  const notSetUp = !!claude.engine && !claude.ready;
  const why = blockedBy.length ? `Do "${blockedBy.join('" and "')}" first.` : problems.length ? "Change the note first (see above)."
    : action === "find_jobs" && lookingWhy ? lookingWhy
    : action === "find_jobs" && boards !== null && !boards.length ? "Tick at least one job board for this search."
    : built.error ? built.error : notSetUp ? "Set up Claude first. The Claude setup button is just below." : claude.running ? "Claude is already working on this." : "";

  const remember = () => bridge.claude.saveOptions(action, target, options).catch(() => undefined);
  const start = () => act(`compose:${action}`, async () => {
    if (before) await before();
    if (action === "find_jobs" && boards?.length) await bridge.chrome?.runBoards(boards);
    // Main rebuilds the prompt from the action, the target and these choices; the renderer never sends prompt text.
    await remember();
    const search = action === "find_jobs" ? describedPatch(described) : {};
    const run = await claude.start({ options, note, ...(Object.keys(search).length ? { search } : {}) });
    onStarted?.(run);
  });
  const copy = async () => {
    let prompt: string;
    try { prompt = compose(); } catch (e) { toast({ tone: "danger", text: (e as Error).message }); return; }
    void remember();
    const ok = await copyText(prompt);
    setCopyFailed(!ok);
    if (!ok) setShowPrompt(true);
    toast(ok ? { tone: "success", text: "Prompt copied" } : { tone: "neutral", text: "Copying didn't work. Select the prompt below and copy it." });
  };
  const whyId = `${useId()}-why`;
  const examples = NOTE_EXAMPLES[action] ?? DEFAULT_EXAMPLES;
  const addExample = (ex: string) => setNote((n) => (n.trim() ? `${n.trim()} ${ex}` : ex).slice(0, NOTE_MAX));

  return (
    <section className="composer" aria-label={`${ACTIONS[action].label}: request for Claude`}>
      <header className="composer__head">
        <span className="composer__mark" aria-hidden="true"><Icon icon={AiIcon} /></span>
        <div className="composer__intro">
          <Text role="heading-2" as="h2" className="composer__sentence">{requestSentence(action, view.info, options, topic)}</Text>
          <div className="composer__files" aria-label="What Claude will create">
            <span className="composer__files-label">What Claude will create</span>
            <ul className="file-chips">
              {files.map((f, i) => (
                <li key={i} className="file-chip" data-optional={f.optional || undefined}>
                  <Icon icon={f.icon} size="sm" />
                  <span>{f.label}</span>
                  {f.optional ? <span className="file-chip__tag">if needed</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>

      {/* Find jobs: what the search is for comes first; how hard to search comes after. */}
      {action === "find_jobs" ? (
        <>
          <div className="composer__section">
            <DescribeSearch value={described} onChange={setDescribed} places={looking?.places ?? []} />
          </div>
          {/* The saved filters, as chips: open when something's missing so the run can start. */}
          <details className="looking__all" open={!!lookingWhy || undefined}>
            <summary>All filters</summary>
            <LookingFor onState={setLooking} sponsorOffered={sponsorOffered} />
          </details>
        </>
      ) : null}
      {defs.length ? (
        <div className="composer__section">
          <Text role="body" as="h3" className="composer__label">{action === "find_jobs" ? "This search only" : "Your choices"}</Text>
          <div className="composer__fields">
            {defs.map((o) => (
              <OptionField key={o.key} option={o} value={options[o.key]!} suggestions={view.suggestions}
                onChange={(v) => setOptions((cur) => ({ ...cur, [o.key]: v }))} />
            ))}
          </div>
        </div>
      ) : null}

      {action === "find_jobs" ? <ComposerBoards value={boards} onChange={setBoards} /> : null}
      {action === "find_jobs" ? <div className="composer__section"><RepeatSearch /></div> : null}

      <div className="composer__section composer__note">
        <Textarea label="Anything else?" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
          help="Optional. A wish about focus or style, in your own words. It can't change the rules below."
          error={problems[0]} placeholder="For example: lead with my most recent project." />
        <div className="composer__note-foot">
          <div className="composer__examples" role="group" aria-label="Example wishes">
            {examples.map((ex) => (
              <button key={ex} type="button" className="example-chip" onClick={() => addExample(ex)} aria-label={`Add to note: ${ex}`}>{ex}</button>
            ))}
          </div>
          <span className="composer__count" data-near={length > NOTE_MAX * 0.9 || undefined}>{length.toLocaleString("en-AU")} / {NOTE_MAX.toLocaleString("en-AU")}</span>
          <span className="sr-only" aria-live="polite">{length > NOTE_MAX * 0.9 ? `${(NOTE_MAX - length).toLocaleString("en-AU")} characters left` : ""}</span>
        </div>
      </div>

      <div className="composer__section">
        <Text role="body" as="h3" className="composer__label">Always on</Text>
        <ul className="always-on">
          {ALWAYS_ON.map((r) => (
            <li key={r.label} className="always-on__item">
              <span className="always-on__badge"><Icon icon={LockIcon} size="sm" />{r.label}</span>
              <span className="always-on__text">{r.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* The main action stays in view at the bottom of a scrolling dialog, so nobody has to hunt for it. */}
      <div className="composer__go">
        <Button variant="primary" icon={AiIcon} loading={busy === `compose:${action}`} disabled={!!why} aria-describedby={why ? whyId : undefined} onClick={() => void start()}>{label}</Button>
        {why ? <Text role="body-sm" className="composer__why" id={whyId}>{why}</Text> : null}
        {action === "find_jobs" ? <AllowHint show={busy === `compose:${action}`} /> : null}
        {status.data?.status === "ready" ? <Pill tone="success">{ACTIONS[action].done}</Pill> : null}
      </div>
      <footer className="composer__foot">
        <ClaudeRunPanel action={action} target={target} run={claude.run} onRetry={() => void start()} />
        <details className="composer__prompt" open={showPrompt} onToggle={(e) => setShowPrompt((e.target as HTMLDetailsElement).open)}>
          <summary title="View the full prompt or run it yourself">Full prompt</summary>
          <div className="composer__prompt-body">
            <Text role="body-sm" muted>{`This is exactly what Claude gets, with folder names shortened here for reading (copying keeps them whole). To run it yourself, copy it into Claude Code, opened in your ${PRODUCT_NAME} folder.`}</Text>
            {preview ? <PromptView prompt={preview} shorten={!copyFailed} /> : <Text role="body-sm" muted>{problems.length ? "Change the note to see the prompt." : built.error}</Text>}
            <div><Button size="sm" variant="ghost" icon={CopyIcon} disabled={!preview} title={preview ? undefined : problems.length ? "Change the note first." : built.error} onClick={() => void copy()}>Copy prompt</Button></div>
          </div>
        </details>
      </footer>
    </section>
  );
}
