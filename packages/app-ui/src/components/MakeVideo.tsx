import { useEffect, useId, useMemo, useState } from "react";
import { Checkbox, Button, Card, Dialog, Icon, Icons, Pill, PRODUCT_NAME, Select, Text, Textarea } from "@careeros/brand";
import {
  ACTION_IDS, ACTIONS, INSTALL_PAGE_URL, isoWeek, showSponsorship, VIDEO_ACTION_TYPES,
  type ActionId, type ActionTarget, type INSTALLABLE_TOOLS, type SetupView, type VideoScreen, type VideoSourcesView, type VideoIntent, type VideoSubjectArg, type VideoToolsView, type VideoTypeView,
} from "@careeros/contract";
import { ToolInstall } from "./ToolInstall";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { useCandidate } from "../candidate";
import { useClaudeEngine } from "../claude";
import { CLAUDE_SETTINGS, navigate, useRoute, type Route } from "../router";
import { sourceName } from "../screens/Video";
import { StartWith } from "./ActionButton";
import { VideoLengthPicker } from "./VideoLength";

/** The catalogue's video actions (addendum) and the video type each one makes (contract owns the map). */
export { VIDEO_ACTION_TYPES };
/** The catalogue action for a video type, for its prerequisites (company research before a company briefing...). */
const actionForType = (typeId: string): ActionId | undefined => ACTION_IDS.find((a) => VIDEO_ACTION_TYPES[a] === typeId);

const NEEDS: Record<VideoTypeView["subject"], string> = {
  job: "Open a job first, then make this video from there.",
  company: "Open a job or a company first, then make this video from there.",
  topic: "Open a Learn topic or a skill gap first, then make this video from there.",
  week: "",
};

/** A missing source's fix, as the catalogue action that makes the file (one click, A's "Start with" pattern). */
const FIX_ACTIONS: Record<string, ActionId> = { "research-company": "research_company", "score-job": "score_job", "prepare-application": "tailor_application" };

export function subjectFor(type: Pick<VideoTypeView, "subject">, target: ActionTarget | null, now: Date): VideoSubjectArg | null {
  switch (type.subject) {
    case "job": return target?.kind === "job" ? { kind: "job", company_slug: target.company_slug, id: target.id } : null;
    case "company": return target && (target.kind === "job" || target.kind === "company") ? { kind: "company", company_slug: target.company_slug } : null;
    case "topic":
      return target?.kind === "topic"
        ? { kind: "topic", topic: target.label, ...(target.company_slug && target.id ? { company_slug: target.company_slug, id: target.id } : {}) }
        : null;
    case "week": return { kind: "week", week: isoWeek(now) };
  }
}

export function targetFromRoute(route: Route): ActionTarget {
  if (route.screen === "job" || route.screen === "apply") return { kind: "job", company_slug: route.slug, id: route.id };
  if (route.screen === "learn" && route.topic) return { kind: "topic", topic: route.topic, label: route.topic.replace(/-/g, " ") };
  return { kind: "workspace" };
}

export function screenForTarget(target: ActionTarget): VideoScreen {
  return target.kind === "job" ? "job" : target.kind === "company" ? "company" : target.kind === "topic" ? "learn.topic" : "home";
}

const SPONSOR_RE = /sponsor|visa/i;
/**
 * A type's description without its sponsorship wording, for people for whom sponsorship doesn't apply
 * (`showSponsorship` off). "recent news, sponsorship evidence and culture" reads "recent news and culture";
 * any other sentence that still mentions it is dropped.
 */
export function withoutSponsorship(text: string): string {
  const t = text
    .replace(/,\s*(?:the\s+)?(?:visa\s+)?sponsorship\s+\w+\s+and\s+/gi, " and ")
    .replace(/,\s*(?:the\s+)?(?:visa\s+)?sponsorship\s+\w+(?=[,.])/gi, "");
  return SPONSOR_RE.test(t) ? t.split(/(?<=[.!?])\s+/).filter((s) => !SPONSOR_RE.test(s)).join(" ") : t;
}

/** HyperFrames installs with npm (Node.js) and the voice runs on Python: offered first, with why they matter here. */
const VIDEO_PREREQS = ["node", "python"] as const;
const PREREQ_WHY = { node: "The video renderer (HyperFrames) installs with it.", python: "Runs the voice that narrates videos." } as const;

/** Which tool a video tool's install needs first, as the reason its Install waits. Null when it can go ahead. */
export function waitsFor(install: string, setup: SetupView | undefined, tools: VideoToolsView): string | null {
  const ready = (id: "node" | "python") => setup?.tools.find((t) => t.id === id)?.state === "ok";
  const videoOk = (id: string) => !tools.tools.some((t) => (t.install === id || t.id === id) && !t.ok);
  if (install === "hyperframes" && setup && !ready("node")) return "Install Node.js first.";
  if (install === "supertonic" && setup && !ready("python")) return "Install Python first.";
  if (install === "whisper" && !videoOk("ffmpeg")) return "Install ffmpeg first.";
  if (install === "whisper" && !videoOk("hyperframes")) return "Install HyperFrames first.";
  return null;
}

/**
 * The tools videos need that this computer is missing, in the same rows as the other setup cards: what a tool needs
 * first (Node.js, Python) at the top, then each video tool with its plain message and Install (Task 21: only on a
 * click, never while a video is being made), live progress with Stop, and "Check again".
 */
export function ToolsMissingCard({ tools, onChanged, onInstalling }: { tools: VideoToolsView; onChanged(): void; onInstalling?(busy: boolean): void }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const runs = useLoad((b) => b.video.runs(), [], ["video"]);
  const making = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running");
  const whyId = useId();
  const missing = tools.tools.filter((t) => !t.ok);
  const setup = useLoad((b) => b.setup.status(false), [], ["setup"]);
  const installing = busy?.startsWith("install:") ? setup.data?.installing ?? null : null;
  const install = (id: string) => run(`install:${id}`, async () => {
    onInstalling?.(true);
    try { await bridge.video.installTool(id as (typeof INSTALLABLE_TOOLS)[number]); } finally { onInstalling?.(false); onChanged(); }
  });
  return (
    <Card role="region" aria-label="Tools for videos" className="stack video-tools-card">
      <Text role="body">Videos need a few tools on this computer first.</Text>
      <ToolInstall ids={VIDEO_PREREQS} why={PREREQ_WHY} onInstalled={onChanged} />
      <ul className="tinstall__list">
        {missing.map((t) => {
          const mine = busy === `install:${t.install}`;
          const waits = t.install ? waitsFor(t.install, setup.data, tools) : null;
          const reason = making ? "A video is being made. Install when it has finished." : busy && !mine ? "Wait for the other tool to finish first." : waits;
          return (
            <li key={t.id} className="tinstall__item">
              <div className="tinstall__head">
                <Text role="body" as="span" className="csetup__title">{t.label}</Text>
                {mine ? <Pill tone="accent">Installing</Pill> : <Pill tone="neutral">{t.required ? "Not installed" : "Optional"}</Pill>}
              </div>
              {mine ? (
                <div className="tinstall__progress" role="status" aria-live="polite" aria-label="Install progress">
                  <span className="tinstall__dot" aria-hidden="true" />
                  <Text role="body-sm" as="span" className="tinstall__line">{installing?.line || `Installing ${t.label}…`}</Text>
                  <Button size="sm" variant="ghost" onClick={() => void bridge.setup.cancel()}>Stop</Button>
                </div>
              ) : (
                <>
                  <Text role="body-sm" muted>{t.message}</Text>
                  {t.install && tools.can_install ? (
                    <div className="csetup__row">
                      <Button size="sm" variant="primary" aria-label={`Install ${t.label}`} disabled={!!reason}
                        aria-describedby={making ? whyId : undefined} title={reason ?? undefined}
                        onClick={() => void install(t.install!)}>Install</Button>
                      {waits && !making ? <Text role="body-sm" muted as="span">{waits}</Text> : null}
                    </div>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {making ? <span id={whyId} className="action__why"><Icon icon={Icons.info} size="sm" />A video is being made. Install the tools when it has finished, or stop it first.</span> : null}
      {!tools.can_install ? (
        <div className="csetup__row">
          <Text role="body-sm" muted as="span">This copy of {PRODUCT_NAME} can&apos;t install them. The install guide lists the commands.</Text>
          <Button size="sm" variant="secondary" onClick={() => void bridge.links.open(INSTALL_PAGE_URL)}>Install guide</Button>
        </div>
      ) : null}
      <div>
        <Button size="sm" variant="ghost" icon={Icons.redo} loading={busy === "check"} disabled={!!busy && busy !== "check"}
          title={busy && busy !== "check" ? "A tool is installing. Check again when it has finished." : undefined}
          onClick={() => void run("check", async () => { await bridge.video.tools(true); onChanged(); })}>Check again</Button>
      </div>
    </Card>
  );
}

/** What a missing source needs, with one click to fix it where the app can. */
function MissingSources({ sources, target, prereqs, onDone, onClose }: {
  sources: VideoSourcesView; target: ActionTarget; prereqs: ActionId[]; onDone(): void; onClose(): void;
}) {
  if (!sources.missing.length) return null;
  const seen = new Set<string>(prereqs);
  return (
    <ul className="stack video-missing" aria-label="Missing files">
      {sources.missing.map((m) => {
        const action = FIX_ACTIONS[m.fix];
        const first = action && !seen.has(action) && target.kind !== "workspace";
        if (action) seen.add(action);
        return (
          <li key={m.resolver} className="stack">
            <span className="action__why"><Icon icon={Icons.info} size="sm" />{m.message}</span>
            {first ? <StartWith action={action} target={target} onDone={onDone} /> : null}
            {m.fix === "add-history" ? (
              <div><Button size="sm" variant="ghost" icon={Icons.dropBox} onClick={() => { onClose(); navigate({ screen: "inbox" }); }}>Drop box</Button></div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function MakeVideoDialog({ open, onClose, target, typeId, note: initialNote }: {
  open: boolean; onClose(): void; target: ActionTarget; typeId?: string; note?: string;
}) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const candidate = useCandidate();
  const engine = useClaudeEngine();
  const sponsorship = !!candidate && showSponsorship(candidate.status);
  const screen = screenForTarget(target);
  const types = useLoad((b) => b.video.types(typeId ? "all" : screen), [screen, typeId ?? ""], ["video", "settings"]);
  const tools = useLoad((b) => b.video.tools(false), [], ["video"]);
  const [picked, setPicked] = useState<string | undefined>(typeId);
  // undefined: the type's default; null: a custom length that can't be read yet.
  const [length, setLength] = useState<number | null | undefined>(undefined);
  const [mode, setMode] = useState<"practice" | "watch" | null>(null);
  const [note, setNote] = useState(initialNote ?? "");
  // Off by default: a script that passes its checks goes straight on to the video; on, Claude stops after the script.
  const [reviewFirst, setReviewFirst] = useState(false);
  const [sound, setSound] = useState(true);
  const soundHelpId = useId();
  const reviewHelpId = useId();
  const [installing, setInstalling] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [existingChoice, setExistingChoice] = useState<"keep_copy" | "replace">("keep_copy");
  const groupName = useId();
  const existingName = useId();
  const whyId = useId();
  useEffect(() => { setPicked(typeId); setNote(initialNote ?? ""); setLength(undefined); setMode(null); setStartError(null); setExistingChoice("keep_copy"); }, [typeId, initialNote, open]);

  const list = useMemo(() => {
    const all = (types.data?.types ?? []).filter((t) => sponsorship || !SPONSOR_RE.test(`${t.id} ${t.label}`));
    return typeId ? all.filter((t) => t.id === typeId || t.entry_points.includes(screen)) : all;
  }, [types.data, typeId, screen, sponsorship]);
  const type = list.find((t) => t.id === (picked ?? list[0]?.id)) ?? (picked ? undefined : list[0]);
  const subject = type ? subjectFor(type, target, new Date()) : null;
  const subjectKey = JSON.stringify(subject);
  const sources = useLoad(
    (b) => (type && subject ? b.video.sources(type.id, subject) : Promise.resolve(null)),
    [type?.id ?? "", subjectKey], ["jobs", "learn", "video"],
  );
  // A's locked-action pattern: a video whose catalogue action needs another first (company research before a
  // company briefing) says so and offers one click to start that step.
  const action = type ? actionForType(type.id) : undefined;
  const gated = !!action && !!ACTIONS[action].requires?.length && !!subject && target.kind !== "workspace";
  const pre = useLoad(
    (b) => (gated && action ? b.claude.status(action, target) : Promise.resolve(null)),
    [gated, action ?? "", JSON.stringify(target)], ["jobs", "learn", "claude"],
  );
  const blockedBy = pre.data?.status === "blocked" ? pre.data.blockedBy : [];

  const why = !types.data ? (types.error ? "Video types can't be loaded." : "Loading the video types…")
    : !type ? (picked ? "That kind of video isn't available here." : "Pick a kind of video.")
    : !subject ? NEEDS[type.subject]
    : length === null ? "Fix the custom length first."
    : blockedBy.length ? `Do ${blockedBy.map((r) => `“${ACTIONS[r].button}”`).join(" and ")} first.`
    : gated && !pre.data && !pre.error ? "Checking what this video needs…"
    : sources.error ? "Your files can't be checked right now."
    : !sources.data ? "Checking your files…"
    : !sources.data.ready ? "Some files this video needs are missing."
    : installing ? "A tool is installing. Start when it has finished."
    : tools.error ? "The video tools can't be checked right now."
    : !tools.data ? "Checking the video tools…"
    : !tools.data.ok ? "Install the missing tools first."
    : "";
  const ready = why === "";

  const start = () => run("start", async () => {
    if (!type || !subject) return;
    setStartError(null);
    try {
      const r = await bridge.video.start(type.id, subject, {
        length_s: length ?? type.default_s ?? type.length.target_s,
        ...(type.modes.length ? { mode: mode ?? type.modes[0]! } : {}),
        ...(type.writer === "claude" && note.trim() ? { note: note.trim() } : {}),
        ...(sources.data?.existing ? { existing: existingChoice } : {}),
        ...(type.writer === "claude" && reviewFirst ? { review: "always" as const } : {}),
        sound: sound ? "on" as const : "off" as const,
      });
      onClose();
      navigate({ screen: "video", folder: r.folder });
    } catch (e) {
      setStartError(errorText(e));
      throw e;
    }
  });

  const claudeOff = type?.writer === "claude" && engine.data && !engine.data.ready;
  return (
    <Dialog open={open} onClose={onClose} title="Make a video"
      actions={(
        <>
          {!ready && why ? <span id={whyId} className="action__why make-video__why"><Icon icon={Icons.info} size="sm" />{why}</span> : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Icons.video} disabled={!ready} loading={busy === "start"} aria-describedby={!ready && why ? whyId : undefined}
            title={ready ? undefined : why} onClick={() => void start()}>Start</Button>
        </>
      )}>
      <div className="stack make-video">
        {types.error && !types.data ? <Text role="body-sm" className="make-video__error">{types.error}</Text> : null}
        {!types.data && !types.error ? <Text role="body-sm" muted>Loading the video types…</Text> : null}
        {types.data && !list.length ? <Text role="body-sm" muted>No videos fit this page. Open a job or a Learn topic to make one.</Text> : null}
        {list.length ? (
          <fieldset className="stack video-types">
            <legend className="field__label">Kind of video</legend>
            {list.map((t) => (
              <label key={t.id} className="video-types__option">
                <input type="radio" name={groupName} value={t.id} checked={type?.id === t.id}
                  onChange={() => { setPicked(t.id); setLength(undefined); setMode(null); }} />
                <span className="video-types__text">
                  <Text role="body" as="span">{t.label}</Text>
                  <Text role="body-sm" as="span" muted>{sponsorship ? t.description : withoutSponsorship(t.description)}</Text>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {type ? (
          <>
            {type.writer === "claude" ? <VideoLengthPicker type={type} making={types.data?.making} onChange={setLength} /> : null}
            {type.writer === "claude" ? (
              <div className="stack make-video__review">
                <Checkbox label="Let me review the script first" checked={reviewFirst} onChange={(e) => setReviewFirst(e.target.checked)} aria-describedby={reviewHelpId} />
                <Text role="body-sm" muted id={reviewHelpId}>{reviewFirst ? "Claude stops after writing the script. You read it, then approve to make the video."
                  : "Claude writes the script, checks it and makes the video. It stops for you only if something needs a look."}</Text>
              </div>
            ) : null}
            <div className="stack make-video__review">
              <Checkbox label="Sound effects" checked={sound} onChange={(e) => setSound(e.target.checked)} aria-describedby={soundHelpId} />
              <Text role="body-sm" muted id={soundHelpId}>{sound ? "Soft whooshes and pops under the voice, made on your Mac." : "Voice only."}</Text>
            </div>
            {type.modes.length ? (
              <div className="make-video__fields">
                <Select label="Mode" value={mode ?? type.modes[0]!} onChange={(e) => setMode(e.target.value as "practice" | "watch")}
                  options={type.modes.map((m) => ({ value: m, label: m === "practice" ? "Practice: pauses to think before each answer" : "Watch: no pauses" }))} />
              </div>
            ) : null}
            {type.writer === "claude" ? (
              <Textarea label="Note for Claude (optional)" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)}
                help="Anything Claude should focus on when it writes the script." />
            ) : <Text role="body-sm" muted>Built from your own data. Claude isn&apos;t asked.</Text>}
            {claudeOff ? (
              <div className="make-video__note">
                <span className="action__why"><Icon icon={Icons.info} size="sm" />Claude Code isn&apos;t set up, so the script request goes to Claude Desktop instead.</span>
                <Button size="sm" variant="ghost" icon={Icons.settings} onClick={() => { onClose(); navigate(CLAUDE_SETTINGS); }}>Claude setup</Button>
              </div>
            ) : null}
            {!subject ? <span className="action__why"><Icon icon={Icons.info} size="sm" />{NEEDS[type.subject]}</span> : null}
            {blockedBy.length ? (
              <div className="make-video__note">
                <span className="action__why"><Icon icon={Icons.locked} size="sm" />Do {blockedBy.map((r) => `“${ACTIONS[r].button}”`).join(" and ")} first.</span>
                <StartWith action={blockedBy[0]!} target={target} onDone={() => { pre.reload(); sources.reload(); }} />
              </div>
            ) : null}
            {sources.data?.existing && subject ? (
              <fieldset className="stack video-types make-video__existing">
                <legend className="field__label">This video already exists</legend>
                <label className="video-types__option">
                  <input type="radio" name={existingName} value="keep_copy" checked={existingChoice === "keep_copy"} onChange={() => setExistingChoice("keep_copy")} />
                  <span className="video-types__text">
                    <Text role="body" as="span">Keep the old one as a dated copy</Text>
                    <Text role="body-sm" as="span" muted>The old video and its script stay in Learn, with today&apos;s date.</Text>
                  </span>
                </label>
                <label className="video-types__option">
                  <input type="radio" name={existingName} value="replace" checked={existingChoice === "replace"} onChange={() => setExistingChoice("replace")} />
                  <span className="video-types__text">
                    <Text role="body" as="span">
                      {sources.data.existing.has_script ? "Replace the existing video? Your edits to the script will be lost." : "Replace the existing video."}
                    </Text>
                    {sources.data.existing.has_final ? <Text role="body-sm" as="span" muted>Its finished video is deleted too.</Text> : null}
                  </span>
                </label>
              </fieldset>
            ) : null}
            {sources.data && subject ? (
              <div className="stack make-video__sources">
                {sources.data.files.length ? (
                  <>
                    <Text role="body-sm" muted>Made from these files:</Text>
                    <ul className="video-sources">{sources.data.files.map((f) => <li key={f.rel}><Text role="body-sm" as="span">{sourceName(f.rel)}</Text></li>)}</ul>
                  </>
                ) : null}
                <MissingSources sources={sources.data} target={target} prereqs={blockedBy} onDone={() => { pre.reload(); sources.reload(); }} onClose={onClose} />
              </div>
            ) : null}
            {subject && !sources.data && !sources.error ? <Text role="body-sm" muted>Checking your files…</Text> : null}
            {sources.error ? <Text role="body-sm" className="make-video__error">{sources.error}</Text> : null}
          </>
        ) : null}
        {tools.data && !tools.data.ok ? <ToolsMissingCard tools={tools.data} onChanged={tools.reload} onInstalling={setInstalling} /> : null}
        {tools.error ? <Text role="body-sm" className="make-video__error">{tools.error}</Text> : null}
        {startError ? <Text role="body-sm" className="make-video__error">{startError}</Text> : null}
      </div>
    </Dialog>
  );
}

export function MakeVideoButton({ target, typeId, label = "Make video", title, ariaLabel, variant = "secondary", size = "sm" }: {
  target: ActionTarget; typeId?: string; label?: string; title?: string; ariaLabel?: string; variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  // In the app, the Shell's listener opens Make video (the same path a services hand-off uses); a button rendered on
  // its own (a test, a preview) opens its own dialog.
  const click = () => { if (!openMakeVideo({ type: typeId ?? "", subject: "", target })) setOpen(true); };
  return (
    <>
      <Button size={size} variant={variant} icon={Icons.video} aria-label={ariaLabel ?? label} title={title} aria-haspopup="dialog" onClick={click}>{label}</Button>
      {open ? <MakeVideoDialog open onClose={() => setOpen(false)} target={target} typeId={typeId} /> : null}
    </>
  );
}

/** The mounted VideoIntentListener's opener, so in-app code (a chat step's button) can open Make video directly. */
let openIntent: ((i: VideoIntent) => void) | null = null;

/**
 * Opens Make video for an in-app caller, such as a chat step's "Open Make video" button. Only code bundled into the
 * app can call it: there is deliberately no window event for this, so no other script in the page can open the
 * dialog with its own type and note. Returns false when no listener is mounted.
 */
export function openMakeVideo(intent: VideoIntent): boolean {
  if (!openIntent) return false;
  openIntent({ type: intent.type, subject: intent.subject, ...(intent.target ? { target: intent.target } : {}) });
  return true;
}

/**
 * Opens Make video when Claude asks for one: a request stored by the services (`videoFlow.open`, read with
 * `video.takeIntent` on each "video" change), or an in-app call to `openMakeVideo`. The target is the
 * page the candidate is on; a topic type opened elsewhere uses Claude's subject as the topic.
 */
export function VideoIntentListener() {
  const bridge = useBridge();
  const route = useRoute();
  const [intent, setIntent] = useState<VideoIntent | null>(null);
  useEffect(() => {
    let live = true;
    const take = () => { void bridge.video.takeIntent().then((i) => { if (live && i) setIntent(i); }, () => {}); };
    take();
    const off = bridge.onChange((e) => { if (e.areas.includes("video")) take(); });
    const open = (i: VideoIntent) => setIntent(i);
    openIntent = open;
    return () => { live = false; off(); if (openIntent === open) openIntent = null; };
  }, [bridge]);
  if (!intent) return null;
  const fromRoute = targetFromRoute(route);
  const topic = intent.subject.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  const target: ActionTarget = intent.target ?? (fromRoute.kind === "workspace" && topic ? { kind: "topic", topic, label: topic } : fromRoute);
  return <MakeVideoDialog open onClose={() => setIntent(null)} target={target} typeId={intent.type || undefined} note={intent.subject.slice(0, 500)} />;
}
