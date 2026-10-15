import { useId, useMemo, useRef, useState } from "react";
import { AiMark, Button, Card, Dialog, Icon, Icons, Input, Pill, Text, Textarea } from "@careeros/brand";
import { DEFAULT_MAKING_RATE, fmtDuration, isActiveRun, type ClaudeRunView, type VideoDraftView, type VideoRunView, type VideoScriptEdits } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { formatCost, formatElapsed, useClaudeRuns } from "../claude/index";
import { friendlyFile, showInFolderLabel } from "../components/files";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { fmtDate, plural } from "../format";
import type { Route } from "../router";
import { BackLink, usePageName } from "../nav";
import { sceneList, sortProblems } from "../video/problems";
import { minutesToMake, videoState, videoStatus } from "../video/stage";
import { StoppedCard } from "../video/Stopped";
import { TimeTaken } from "../video/TimeTaken";
import { RunPanel } from "../video/RunProgress";
import { SlidePreview } from "../video/SlidePreview";
import "../video/video.css";

const ACTIVE = new Set<VideoRunView["status"]>(["queued", "running"]);
/** Plain names for the files a script cites, in place of their workspace paths. */
const SOURCE_NAMES: [RegExp, string][] = [
  [/(^|\/)jd\.md$/, "Job ad"], [/(^|\/)job\.json$/, "Job details"], [/(^|\/)research\.md$/, "Company research"], [/(^|\/)score\.md$/, "Job score"],
  [/(^|\/)questions\.md$/, "Interview questions"], [/(^|\/)profile\.(json|md)$/, "Your profile"], [/(^|\/)company\.json$/, "Company details"],
  [/(^|\/)stats\.json$/, "Your week's numbers"],
];
export function sourceName(rel: string): string {
  return SOURCE_NAMES.find(([re]) => re.test(rel))?.[1] ?? friendlyFile(rel).title;
}
/** "me/identity" → "your identity folder". A locked folder is always one of the person's own. */
export function lockedName(folder: string): string {
  const last = String(folder ?? "").split("/").filter(Boolean).pop() ?? folder;
  return `your ${last.replace(/[-_]+/g, " ")} folder`;
}
const lockedList = (d: VideoDraftView) => {
  const names = [...new Set(d.locked_facts.map((l) => lockedName(l.folder)))];
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

export { RunPanel, videoProgress } from "../video/RunProgress";

/** The script writer's Claude Code run for this video: the newest one, live or finished. */
function useWriterRun(folder: string): ClaudeRunView | null {
  const runs = useClaudeRuns();
  return useMemo(() => {
    const mine = (runs.data ?? []).filter((r) => r.action === "video_script" && r.key === `video_script--${folder}`);
    return mine.find((r) => isActiveRun(r.status)) ?? [...mine].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
  }, [runs.data, folder]);
}

/** Run details for a finished writer run: when, how long and the cost estimate (as lane H shows it). */
function WriterDetails({ run }: { run: ClaudeRunView }) {
  const day = fmtDate(run.ended_at || run.started_at);
  const what = run.status === "succeeded" ? "Claude wrote this script" : run.status === "cancelled" ? "Claude's script run was stopped" : "Claude's script run didn't finish";
  return (
    <details className="video-details">
      <summary><Text role="body-sm" as="span">Run details</Text></summary>
      <div className="stack video-details__body">
        <Text role="body-sm">{what}{day ? ` on ${day}` : ""}.</Text>
        <Text role="body-sm" muted>Time taken {formatElapsed(run.elapsed_ms)}{run.turns !== null ? ` · ${plural(run.turns, "turn")}` : ""}</Text>
        {run.cost_usd !== null ? (
          <Text role="body-sm" muted title="Claude Code's own estimate. On a Pro or Max plan this counts against your plan's limits instead of being billed.">
            Cost estimate: {formatCost(run.cost_usd)}
          </Text>
        ) : null}
      </div>
    </details>
  );
}

/** Unsaved edits: scene index -> script, and "index:path" -> field value. Held by the screen, so they outlive the review. */
export interface ReviewEdits { scripts: Record<number, string>; fields: Record<string, string> }
const NO_EDITS: ReviewEdits = { scripts: {}, fields: {} };
const hasEdits = (e: ReviewEdits) => Object.keys(e.scripts).length > 0 || Object.keys(e.fields).length > 0;

/** The note sent with "Ask Claude to fix these": Claude also gets the check's own findings. */
export const FIX_NOTE = "Fix every problem the script check found. Keep what the script says the same.";

/** What the checks already put right on their own (the pipeline's autofix), and what is left: "" when nothing was. */
export function fixedLine(d: VideoDraftView): string {
  const a = d.autofix;
  if (!a) return "";
  const parts = [
    a.claude_fixed > 0 ? `Claude already fixed ${plural(a.claude_fixed, "problem")}` : "",
    a.repairs.length > 0 ? `${plural(a.repairs.length, "small format slip")} ${a.repairs.length === 1 ? "was" : "were"} put right` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const done = `${parts.join(", and ")}.`;
  // No raw count of what's left: the check counts every spec path, the page groups them. The list below says it.
  return a.left > 0 ? `${done} The rest are listed below.` : done;
}

/** The one line under the review's heading: where this video is and what happens next. */
export function reviewStatus(p: { format: number; content: number; minutes: number | null }): string {
  const make = `approve to make a draft${p.minutes ? ` (about ${p.minutes} min)` : ""}`;
  if (p.format) return "Script written, but Claude needs to fix how parts of it are set up. Ask Claude to fix them, then review it.";
  if (p.content) return `Script written. Fix what's marked below, then ${make}.`;
  return `Script written. Review it, then ${make}.`;
}

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

export function ScriptReview({ draft, folder, onSaved, writer, edits: given, onEdit, kept, onDiscard }: {
  draft: VideoDraftView; folder: string; onSaved(): void; writer?: ClaudeRunView | null;
  /** Optional: edits held by the parent (VideoScreen), so a run starting elsewhere doesn't lose them. */
  edits?: ReviewEdits; onEdit?(update: (e: ReviewEdits) => ReviewEdits): void;
  /** The edits were kept while a run for this video went on: say so, and offer to drop them. */
  kept?: boolean; onDiscard?(): void;
}) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const reasonId = useId();
  const saveWhyId = useId();
  const sendWhyId = useId();
  const [own, setOwn] = useState<ReviewEdits>(NO_EDITS);
  const { scripts, fields } = given ?? own;
  const update = onEdit ?? setOwn;
  const setScripts = (f: (m: Record<number, string>) => Record<number, string>) => update((e) => ({ ...e, scripts: f(e.scripts) }));
  const setFields = (f: (m: Record<string, string>) => Record<string, string>) => update((e) => ({ ...e, fields: f(e.fields) }));
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const types = useLoad((b) => (typeof b.video?.types === "function" ? b.video.types("all") : Promise.resolve(null)), [], ["video"]);
  const dirty = Object.keys(scripts).length > 0 || Object.keys(fields).length > 0;
  const p = useMemo(() => sortProblems(draft), [draft]);
  const errors = p.content.filter((c) => c.level === "error");
  const whole = p.content.filter((c) => c.scene === null);
  const sceneErrors = [...new Set(errors.filter((c) => c.scene !== null).map((c) => c.scene!))];
  const blocked = p.format.length > 0;
  const fixFirst = blocked && draft.can_revise;
  const rate = types.data?.making ?? DEFAULT_MAKING_RATE;
  const minutes = draft.estimated_s ? minutesToMake(draft.estimated_s, rate.per_video_s) : null;
  // A scene opens for editing when clicked, and stays open while it has unsaved edits.
  const editing = (i: number) => open.has(i) || scripts[i] !== undefined || Object.keys(fields).some((k) => k.startsWith(`${i}:`));
  const toggle = (i: number, on: boolean) => setOpen((o) => { const n = new Set(o); if (on) n.add(i); else n.delete(i); return n; });

  const edits = (): VideoScriptEdits => ({
    scenes: draft.scenes.flatMap((s) => {
      const script = scripts[s.index];
      const changed = s.fields.filter((f) => fields[`${s.index}:${f.path}`] !== undefined).map((f) => ({ path: f.path, value: fields[`${s.index}:${f.path}`]! }));
      if (script === undefined && !changed.length) return [];
      return [{ index: s.index, ...(script !== undefined ? { script } : {}), ...(changed.length ? { fields: changed } : {}) }];
    }),
  });
  const save = () => run("save", async () => { await bridge.video.saveScript(folder, edits()); setOpen(new Set()); onSaved(); }, "Script saved");
  const approve = () => run("approve", async () => { await bridge.video.approveScript(folder); onSaved(); }, "Making a quick draft of your video. You can leave this page.");
  const revise = (text: string, key: string) => run(key, async () => { await bridge.video.revise(folder, text); setRevising(false); onSaved(); }, "Claude is fixing the script");
  const reason = dirty ? "Save your changes first."
    : draft.can_approve ? ""
    : blocked ? (draft.can_revise ? "Claude needs to fix the script's set-up first." : "The script's set-up has problems that only Claude can fix.")
    : errors.length ? "Fix what's marked in the script first."
    : "The script can't be approved right now. Wait for the current step to finish.";
  const length = [
    plural(draft.scenes.length, "scene"),
    draft.estimated_s ? `about ${fmtDuration(draft.estimated_s)} long` : "",
    draft.asked_s ? `you asked for about ${fmtDuration(draft.asked_s)}` : `aim for ${fmtDuration(draft.length.min_s)} to ${fmtDuration(draft.length.max_s)}`,
  ].filter(Boolean).join(" · ");

  return (
    <section className="stack vreview" aria-labelledby="video-review">
      <header className="stack vreview__head">
        <Text role="heading-2" as="h2" id="video-review">Review the script</Text>
        <Text role="body" className="video-status" data-testid="video-status">{reviewStatus({ format: p.format.length, content: errors.length, minutes })}</Text>
        <Text role="body-sm" muted data-testid="video-summary">{length}. Nothing is narrated until you approve. Click a scene to change its words.</Text>
        {fixedLine(draft) ? <Text role="body-sm" muted data-testid="video-autofix">{fixedLine(draft)}</Text> : null}
      </header>
      {kept && dirty ? (
        <Card className="video-note" role="status">
          <Icon icon={Icons.info} size="sm" />
          <Text role="body-sm" className="grow">Your unsaved edits were kept.</Text>
          {onDiscard ? <Button size="sm" variant="ghost" onClick={onDiscard}>Discard edits</Button> : null}
        </Card>
      ) : null}
      {blocked || errors.length || whole.length ? (
        <Card className="stack video-problems" role="region" aria-labelledby="video-problems-title">
          <Text role="body" as="h3" id="video-problems-title" className="video-problems__title">{blocked || errors.length ? "Before you approve" : "Worth a look"}</Text>
          <ul className="list-plain stack video-problems__list">
            {blocked ? (
              <li className="video-problem video-problem--format">
                <Icon icon={AiMark} size="sm" />
                <Text role="body-sm">Claude wrote parts of this script in the wrong format. Ask Claude to fix it.</Text>
              </li>
            ) : null}
            {whole.map((c, n) => (
              <li key={n} className={`video-problem video-problem--${c.level}`}><Icon icon={Icons.info} size="sm" /><Text role="body-sm">{c.text}</Text></li>
            ))}
            {sceneErrors.length ? (
              <li className="video-problem video-problem--error">
                <Icon icon={Icons.info} size="sm" />
                <Text role="body-sm">{sceneList(sceneErrors)} {sceneErrors.length === 1 ? "needs" : "need"} a change. It&apos;s marked below.</Text>
              </li>
            ) : null}
          </ul>
          {fixFirst ? (
            <div><Button variant="primary" icon={AiMark} loading={busy === "fix"} title="Ask Claude to fix these" onClick={() => void revise(FIX_NOTE, "fix")}>Fix issues</Button></div>
          ) : null}
          {p.technical.length ? (
            <details className="video-tech">
              <summary><Text role="body-sm" as="span">Technical details</Text></summary>
              <Text role="body-sm" muted>What the script check found, word for word. Claude gets this list when you ask it to fix the script.</Text>
              <ol className="video-tech__list">{p.technical.map((t, n) => <li key={n}><code>{t}</code></li>)}</ol>
            </details>
          ) : null}
        </Card>
      ) : null}
      {draft.locked_facts.length ? (
        <Card className="video-note" role="note">
          <Icon icon={Icons.locked} size="sm" />
          <Text role="body-sm">This script uses facts from {lockedList(draft)}, which you allowed Claude to read. Check them before you share the video.</Text>
        </Card>
      ) : null}
      <ol className="vscenes" aria-label="Scenes">
        {draft.scenes.map((s) => {
          const mine = p.content.filter((c) => c.scene === s.index);
          const broken = p.formatScenes.has(s.index);
          const text = scripts[s.index] ?? s.script;
          const live = s.fields.map((f) => ({ ...f, value: fields[`${s.index}:${f.path}`] ?? f.value }));
          const on = editing(s.index);
          const cited = s.sources.filter((c) => typeof c.file === "string" && c.file);
          const n = s.index + 1;
          return (
            <li key={s.index} className="vscene" aria-label={`Scene ${n}`} id={`video-scene-${n}`} data-editing={on ? "" : undefined}
              data-problem={mine.some((c) => c.level === "error") || broken ? "" : undefined}>
              <span className="vscene__num" aria-hidden="true">{n}</span>
              <div className="stack vscene__body">
                {mine.length || broken ? (
                  <ul className="list-plain video-scene__issues" aria-label={`Scene ${n}: what needs a change`}>
                    {mine.map((c, k) => (
                      <li key={k} className={`video-problem video-problem--${c.level}`}><Icon icon={Icons.info} size="sm" /><Text role="body-sm">{c.text}</Text></li>
                    ))}
                    {broken ? <li className="video-problem video-problem--format"><Icon icon={AiMark} size="sm" /><Text role="body-sm" muted>Claude needs to fix how this scene is set up.</Text></li> : null}
                  </ul>
                ) : null}
                {on ? (
                  <div className="stack vscene__edit">
                    <Textarea
                      label={`Scene ${n} script`} value={text} maxLength={4000} disabled={s.shared}
                      help={s.shared ? "This paragraph is shared with the scene before. Edit it there." : `${plural(words(text), "word")}, about ${fmtDuration(words(text) / 2.5)} spoken.`}
                      onChange={(e) => { const v = e.target.value; setScripts((m) => ({ ...m, [s.index]: v })); }}
                    />
                    {live.length ? <Text role="label" as="span" className="vscene__onscreen">On screen</Text> : null}
                    <div className="vscene__fields">
                      {live.map((f) => {
                        const key = `${s.index}:${f.path}`;
                        if (broken && !f.value.trim() && fields[key] === undefined) {
                          return (
                            <div key={f.path} className="video-field-hint" role="group" aria-label={`Scene ${n}: ${f.label}`}>
                              <Text role="label" as="span">{f.label}</Text>
                              <Text role="body-sm" muted>Empty because of the format problem. It fills in when Claude fixes the script.</Text>
                            </div>
                          );
                        }
                        const count = words(f.value);
                        const over = f.max_words > 0 && count > f.max_words;
                        return (
                          <Input
                            key={f.path} label={`Scene ${n}: ${f.label}`} value={f.value}
                            help={f.max_words && !over ? `${count} of ${f.max_words} words` : undefined}
                            error={over ? `${count} words. Keep it to ${f.max_words}.` : undefined}
                            onChange={(e) => { const v = e.target.value; setFields((m) => ({ ...m, [key]: v })); }}
                          />
                        );
                      })}
                    </div>
                    {!dirtyScene(s.index, scripts, fields) ? (
                      <div><Button size="sm" variant="ghost" onClick={() => toggle(s.index, false)}>Done</Button></div>
                    ) : <Text role="body-sm" muted>Save your edits to keep them.</Text>}
                  </div>
                ) : (
                  <button type="button" className="vscene__read" aria-label={`Edit scene ${n}`} onClick={() => toggle(s.index, true)}>
                    <Text role="body" as="span" className="vscene__script">{text || "No narration yet."}</Text>
                    <span className="vscene__hint"><Icon icon={Icons.compose} size="sm" />Edit</span>
                  </button>
                )}
                {cited.length ? (
                  <details className="video-details vscene__sources">
                    <summary><Text role="body-sm" as="span">{`Sources (${cited.length})`}</Text></summary>
                    <ul className="list-plain video-sources" aria-label={`Scene ${n} sources`}>
                      {cited.map((c, k) => {
                        const site = c.url ? host(c.url) : "";
                        return (
                          <li key={k}>
                            <Text role="body-sm" as="span">{sourceName(c.file)}</Text>
                            {c.quote ? <Text role="body-sm" as="span" muted>{`: "${c.quote}"`}</Text> : null}
                            {site ? <Text role="body-sm" as="span" muted>{` (${site})`}</Text> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ) : null}
              </div>
              <SlidePreview fields={live} label={`Scene ${n} on screen`} />
            </li>
          );
        })}
      </ol>
      {draft.extras.map((x) => (
        <details key={x.name} className="video-details">
          <summary><Text role="body-sm" as="span">{friendlyFile(x.name).title}</Text></summary>
          <pre className="markdown video-details__body">{x.text || "Nothing written yet."}</pre>
        </details>
      ))}
      {writer && !isActiveRun(writer.status) ? <WriterDetails run={writer} /> : null}
      <div className="vreview__bar" role="group" aria-label="Script actions">
        {draft.can_revise ? <Button variant="ghost" icon={AiMark} title={fixFirst ? "Ask Claude for other changes" : "Ask Claude to revise the script"} onClick={() => setRevising(true)}>{fixFirst ? "Other changes" : "Revise"}</Button> : null}
        <span className="grow" />
        {reason ? <span id={reasonId} className="action__why"><Icon icon={Icons.info} size="sm" />{reason}</span> : null}
        <Button disabled={!dirty} aria-describedby={!dirty ? saveWhyId : undefined} loading={busy === "save"} onClick={() => void save()}>Save edits</Button>
        {!dirty ? <span id={saveWhyId} className="sr-only">No changes to save.</span> : null}
        <Button variant={fixFirst ? "secondary" : "primary"} disabled={!!reason} aria-describedby={reason ? reasonId : undefined} loading={busy === "approve"} title="Approve the script and make a draft video" onClick={() => void approve()}>Approve script</Button>
      </div>
      <Dialog open={revising} onClose={() => setRevising(false)} title="Ask Claude to revise"
        actions={(
          <>
            {!note.trim() ? <span id={sendWhyId} className="action__why">Write what should change first.</span> : null}
            <Button variant="ghost" onClick={() => setRevising(false)}>Cancel</Button>
            <Button variant="primary" disabled={!note.trim()} aria-describedby={!note.trim() ? sendWhyId : undefined} loading={busy === "revise"} onClick={() => void revise(note.trim(), "revise")}>Send</Button>
          </>
        )}>
        <Textarea label="What should change?" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
          help={dirty ? "Claude starts from the saved script. Save your changes first if you want Claude to keep them." : undefined} />
        {blocked || errors.length ? <Text role="body-sm" muted>Claude also gets the problems the check found.</Text> : null}
      </Dialog>
    </section>
  );
}

const dirtyScene = (i: number, scripts: Record<number, string>, fields: Record<string, string>) =>
  scripts[i] !== undefined || Object.keys(fields).some((k) => k.startsWith(`${i}:`));

const NOTE_AREAS: Record<string, string> = { layout: "Layout", contrast: "Contrast", motion: "Motion", runtime: "Playback", check: "Video check" };

/** What the video check noted but didn't stop the video for: one line, the notes behind "Show notes". */
export function CheckNotes({ notes }: { notes: { area: string; text: string }[] }) {
  return (
    <div className="video-notes" data-testid="video-check-notes">
      <Text role="body-sm" as="span">Delivered with {plural(notes.length, "note")}</Text>
      <details className="video-details video-notes__more">
        <summary><Text role="body-sm" as="span">Show notes</Text></summary>
        <Text role="body-sm" muted>The video check found these and made the video anyway. Have a look before you share it.</Text>
        <ul className="video-notes__list">
          {notes.map((n, i) => (
            <li key={i}><Text role="body-sm" as="span" muted>{`${NOTE_AREAS[n.area] ?? "Video check"}: `}</Text><Text role="body-sm" as="span">{n.text}</Text></li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function VideoPreview({ draft, folder }: { draft: VideoDraftView; folder: string }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [sheetOk, setSheetOk] = useState(true);
  const player = useRef<HTMLVideoElement>(null);
  const src = draft.files.final ?? draft.files.draft;
  if (!src) return null;
  const exportCaptions = (format: "srt" | "vtt") => run(`captions-${format}`, async () => {
    const rel = await bridge.video.exportCaptions(folder, format);
    await bridge.files.reveal(rel);
  }, `Captions saved next to the video (captions.${format}).`);
  const done = draft.status === "done";
  return (
    <section className="stack" aria-labelledby="video-preview">
      <div className="row">
        <Text role="heading-2" as="h2" id="video-preview" className="grow">Preview</Text>
        {done ? <Pill tone="success">Final video saved</Pill> : <Pill tone="neutral">Draft</Pill>}
        {draft.qa ? (
          <span className="row video-qa">
            <Text role="body-sm" as="span" muted>Quality check</Text>
            <Pill tone={draft.qa.status === "passed" ? "success" : "warning"}>{draft.qa.status === "passed" ? "Passed" : plural(draft.qa.open_issues, "open issue")}</Pill>
          </span>
        ) : null}
      </div>
      {!done ? <Text role="body-sm" muted>This is a quick draft. The final video is sharper.</Text> : null}
      {draft.check_notes?.length ? <CheckNotes notes={draft.check_notes} /> : null}
      <video ref={player} className="video-player" controls preload="metadata" src={bridge.fileUrl(src)} aria-label={`${draft.title || draft.type_label} video`} />
      {draft.chapters?.length ? (
        <nav aria-label="Chapters" className="stack">
          <Text role="body-sm" muted>Chapters</Text>
          <ol className="video-chapters">
            {draft.chapters.map((c, i) => (
              <li key={`${i}-${c.start_s}`}>
                <button type="button" className="video-chapters__item" aria-label={`Play from ${fmtDuration(c.start_s)}: ${c.title}`}
                  onClick={() => { const v = player.current; if (v) { v.currentTime = c.start_s; void v.play?.()?.catch?.(() => {}); } }}>
                  <span className="video-chapters__time">{fmtDuration(c.start_s)}</span>
                  <Text role="body" as="span">{c.title}</Text>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      {draft.files.contact_sheet && sheetOk
        ? <img className="video-sheet" src={bridge.fileUrl(draft.files.contact_sheet)} alt="Contact sheet: one frame from each scene" onError={() => setSheetOk(false)} /> : null}
      {draft.captions_estimated ? <Text role="body-sm" muted>Captions use estimated timings because the transcription model isn't ready yet.</Text> : null}
      {draft.voice.fell_back ? <Text role="body-sm" muted>The Supertonic voice wasn't available, so the system voice read this one.</Text> : null}
      <TimeTaken timings={draft.timings} />
      {draft.locked_facts.length ? (
        <Card className="video-note" role="note">
          <Icon icon={Icons.locked} size="sm" />
          <Text role="body-sm">This video uses facts from {lockedList(draft)}. Check it before you share it or its captions.</Text>
        </Card>
      ) : null}
      <div className="row">
        <Button variant={done ? "secondary" : "primary"} icon={Icons.video} loading={busy === "final"}
          onClick={() => void run("final", () => bridge.video.render(folder, "final"))}>{done ? "Render again" : "Make final"}</Button>
        <Button icon={Icons.exportFile} loading={busy === "captions-srt"} title="Export captions (.srt)" onClick={() => void exportCaptions("srt")}>Export SRT</Button>
        <Button icon={Icons.exportFile} loading={busy === "captions-vtt"} title="Export captions (.vtt)" onClick={() => void exportCaptions("vtt")}>Export VTT</Button>
      </div>
    </section>
  );
}

export function VideoScreen({ route }: { route: Route }) {
  const folder = route.screen === "video" ? route.folder : "";
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [version, setVersion] = useState(0);
  const [edits, setEdits] = useState<ReviewEdits>(NO_EDITS);
  const [kept, setKept] = useState(false);
  const draft = useLoad((b) => b.video.draft(folder), [folder, version], ["video"]);
  const runs = useLoad((b) => b.video.runs(), [folder], ["video"]);
  const writer = useWriterRun(folder);
  const d = draft.data;
  usePageName(d ? d.title || d.type_label : undefined);
  if (!d) {
    return (
      <>
        <BackLink route={route} />
        {draft.error
          ? <ErrorState title="This video can't be opened" text={draft.error} action={<div><Button onClick={() => draft.reload()}>Try again</Button></div>} />
          : <Loading />}
      </>
    );
  }
  const active = runs.data?.find((r) => r.folder === folder && ACTIVE.has(r.status));
  // A run for this video (from here, chat or anywhere) hides the review; unsaved edits wait here for it to come back.
  if (active && hasEdits(edits) && !kept) setKept(true);
  const saved = () => { setEdits(NO_EDITS); setKept(false); setVersion((v) => v + 1); };
  const sub = [d.title ? d.type_label : "", d.estimated_s ? `about ${fmtDuration(d.estimated_s)}` : ""].filter(Boolean).join(" · ");
  const stopped = d.status === "failed" ? d.stopped ?? null : null;
  // A record left saying "rendering" with no live run (the app quit mid-run) reads as stopped, the same as the lists.
  const left = active || !runs.data ? null : videoState({ folder, status: d.status, error: d.error, final: d.files.final, draft: d.files.draft }, runs.data);
  const stale = left?.kind === "stale" ? left : null;
  const stage = stale ? { text: stale.text, tone: stale.tone, title: undefined } : videoStatus(active ? (active.phase === "write" ? "writing" : "rendering") : d.status, d.error);
  const review = <ScriptReview key={version} draft={d} folder={folder} writer={writer} onSaved={saved}
    edits={edits} onEdit={setEdits} kept={kept} onDiscard={() => { setEdits(NO_EDITS); setKept(false); }} />;
  return (
    <>
      <BackLink route={route} />
      <ScreenHead
        title={d.title || d.type_label}
        sub={<span className="row video-head__sub">{sub ? <span>{sub}</span> : null}<span title={stage.title}><Pill tone={stage.tone}>{stage.text}</Pill></span></span>}
        right={<Button variant="ghost" icon={Icons.showInFolder} onClick={() => void run("reveal", () => bridge.files.reveal(folder))}>{showInFolderLabel()}</Button>}
      />
      <div className="stack video-screen">
        {draft.error ? <Text role="body-sm" muted>{`Couldn't refresh this video: ${draft.error}`}</Text> : null}
        {active ? <RunPanel run={active} writer={writer} cancelling={busy === "cancel"} onCancel={() => void run("cancel", () => bridge.video.cancel(active.runId))} /> : null}
        {stale ? (
          <Card role="alert" className="stack video-failed" data-testid="video-stale">
            <Text role="body">{stale.next === "retry"
              ? "Making this video stopped before it finished, maybe because the app closed. Your script is fine."
              : "Writing the script stopped before it finished, maybe because the app closed."}</Text>
            {stale.next === "retry" ? (
              <div className="row"><Button variant="primary" icon={Icons.redo} loading={busy === "retry"} onClick={() => void run("retry", async () => { await bridge.video.retry(folder, {}); saved(); }, "Trying again")}>Try again</Button></div>
            ) : null}
          </Card>
        ) : null}
        {!active && stopped ? <StoppedCard stopped={stopped} folder={folder} onRetried={saved} timings={d.timings} /> : null}
        {!active && !stopped && d.status === "failed" && d.error ? <Card role="alert" className="video-failed"><Text role="body">{d.error}</Text></Card> : null}
        {!active && d.status === "cancelled" ? <Text role="body" muted>Cancelled. Your script is kept. Approve it again when you are ready.</Text> : null}
        {!active ? <VideoPreview draft={d} folder={folder} /> : null}
        {!active && d.scenes.length && stopped ? (
          <details className="video-details video-script-later">
            <summary><Text role="body" as="span">Your script ({plural(d.scenes.length, "scene")})</Text></summary>
            <div className="video-details__body">{review}</div>
          </details>
        ) : null}
        {!active && d.scenes.length && !stopped ? review : null}
        {!active && !d.scenes.length && d.status !== "failed" && d.status !== "cancelled"
          ? <EmptyState boxed text="The script isn't ready yet. It shows here as soon as it is." /> : null}
      </div>
    </>
  );
}
