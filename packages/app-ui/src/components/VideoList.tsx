import { useState } from "react";
import { Button, Card, Dialog, Icon, Icons, Pill, PRODUCT_NAME, Text, useToast } from "@careeros/brand";
import { fmtDuration, showSponsorship, topicSlug as slugOfTopic, type ActionTarget, type VideoListItem } from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { useCandidate } from "../candidate";
import { navigate } from "../router";
import { displayName } from "./displayName";
import { friendlyFile } from "./files";
import { MakeVideoButton, ToolsMissingCard, withoutSponsorship } from "./MakeVideo";
import { Loading } from "./States";
import { UNDO_MS } from "../trash/useDelete";
import { fmtMaking, videoState } from "../video/stage";
import { fmtDayOf } from "../reading/dates";

export const VIDEO_SECTION_LABELS: Record<VideoListItem["section"], string> = {
  topics: "Topic videos", jobs: "Job videos", companies: "Company videos", recaps: "Weekly recaps",
};

/** A path-like token: absolute ("/Users/…", "~/…", "C:\\…") or with two or more folders ("a/b/c.md"). */
const PATH_RE = /(?<![\w.@-])(?:(?:~|[A-Za-z]:)?[\\/](?:[\w.@-]+[\\/])*[\w.@-]+|(?:[\w.@-]+[\\/]){2,}[\w.@-]*)[\\/]?/g;
/** Text with every path replaced by the name of the file or folder it ends in ("/Users/x/notes.txt" → "notes.txt"). */
export function withoutPaths(text: string): string {
  return text.replace(PATH_RE, (m) => m.split(/[\\/]/).filter(Boolean).pop() ?? "");
}

/**
 * Sponsorship wording only for people it applies to (`showSponsorship`); file-derived and service text is sanitised
 * like a file name, and any path in it is cut to the name it ends in.
 */
function useWords() {
  const candidate = useCandidate();
  const sponsorship = !!candidate && showSponsorship(candidate.status);
  return (text: string) => {
    const shown = withoutPaths(displayName(text));
    return sponsorship ? shown : withoutSponsorship(shown);
  };
}

/** The Make video target for a listed video's subject, for "Make it again" on an older script-only folder. */
export function targetOfSubject(s: VideoListItem["subject"]): ActionTarget {
  if (s.kind === "job") return { kind: "job", company_slug: s.company_slug, id: s.id };
  if (s.kind === "company") return { kind: "company", company_slug: s.company_slug };
  if (s.kind === "topic") return { kind: "topic", topic: slugOfTopic(s.topic), label: s.topic, ...(s.company_slug && s.id ? { company_slug: s.company_slug, id: s.id } : {}) };
  return { kind: "workspace" };
}

/** A still from the video (its contact sheet or first QA frame), or the video icon when it has none or it won't load. */
function Poster({ rel }: { rel?: string | null }) {
  const bridge = useBridge();
  const [ok, setOk] = useState(true);
  return (
    <span className="video-row__poster" aria-hidden="true">
      {rel && ok ? <img src={bridge.fileUrl(rel)} alt="" loading="lazy" onError={() => setOk(false)} /> : <Icon icon={Icons.video} size="md" />}
    </span>
  );
}

/**
 * One section of videos. `canRender` is false when the tools for videos are missing: Render again is then left
 * off every row, and the single notice above the sections (VideoRegions) says why and how to fix it. `context`
 * off hides the "for which job" text (a job's own Videos tab). Each row says where the video is in plain words
 * (videoState), with its next step: make the video from its script, try a stopped step again, or open it.
 */
export function VideoRows({ items, label, canRender = true, context: showContext = true, heading = true }: {
  items: VideoListItem[]; label: string; canRender?: boolean; context?: boolean; heading?: boolean;
}) {
  const bridge = useBridge();
  const toast = useToast();
  const words = useWords();
  const { busy, run } = useAction();
  const runs = useLoad((b) => b.video.runs(), [], ["video"]);
  const [deleting, setDeleting] = useState<VideoListItem | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  if (!items.length) return null;
  const typeOf = (v: VideoListItem) => words(v.type_label) || "Video";
  const nameOf = (v: VideoListItem) => words(v.title) || typeOf(v);
  const open = (v: VideoListItem) => navigate({ screen: "video", folder: v.folder });
  const del = (v: VideoListItem) => run(`delete:${v.folder}`, async () => {
    // A refusal (other files in the folder, Task 19) shows on the row itself, not just in a passing toast.
    try {
      const entry = await bridge.video.delete(v.folder);
      setFailed(({ [v.folder]: _drop, ...rest }) => rest);
      toast({
        text: "Video deleted", tone: "success", timeoutMs: UNDO_MS,
        action: { label: "Undo", ariaLabel: `Undo deleting ${nameOf(v)}`, onClick: () => void bridge.trash.restore(entry.id).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) })) },
      });
    } catch (e) {
      setFailed((f) => ({ ...f, [v.folder]: words(errorText(e)) || "This video can't be deleted right now." }));
    } finally {
      setDeleting(null);
    }
  });
  // Make the video from its script (the same path as Approve on the video's page), or try the stopped step again.
  const make = (v: VideoListItem) => run(`make:${v.folder}`, () => bridge.video.approveScript(v.folder), "Making a quick draft of your video");
  const retry = (v: VideoListItem) => run(`retry:${v.folder}`, () => bridge.video.retry(v.folder, {}), "Trying again");
  return (
    <section className="stack video-section" aria-label={label} role="region">
      {heading ? <Text role="heading-2" as="h2">{label}</Text> : null}
      <ul className="video-rows">
        {items.map((v) => {
          const name = nameOf(v);
          const context = showContext ? words(v.context) : "";
          const st = videoState({ ...v, error: words(v.error ?? "") }, runs.data ?? []);
          const made = fmtDayOf(v.created_at);
          const took = fmtMaking(v.making_ms);
          return (
            <li key={v.folder} className="video-row" data-state={st.kind}>
              <Poster rel={v.poster} />
              <div className="grow stack video-row__text">
                {v.legacy
                  ? <Text role="body" truncate title={name}>{name}</Text>
                  : <button type="button" className="video-row__title" title={name} tabIndex={-1} aria-hidden="true" onClick={() => open(v)}><Text role="body" truncate as="span">{name}</Text></button>}
                <div className="row video-row__meta">
                  {name !== typeOf(v) ? <Text role="body-sm" muted as="span" className="video-row__fact">{typeOf(v)}</Text> : null}
                  {context ? <Text role="body-sm" muted as="span" truncate title={context} className="video-row__fact">{context}</Text> : null}
                  {v.length_s ? <Text role="body-sm" muted as="span" className="video-row__fact" title="Length">{fmtDuration(v.length_s)}</Text> : null}
                  {made ? <Text role="body-sm" muted as="span" className="video-row__fact">{`Started ${made}`}</Text> : null}
                  {took && (st.kind === "done" || st.kind === "draft") ? <Text role="body-sm" muted as="span" className="video-row__fact">{`Took ${took} to make`}</Text> : null}
                  <span title={st.title}><Pill tone={st.tone}>{st.text}</Pill></span>
                  {v.used_locked ? <Pill tone="warning">Uses private facts</Pill> : null}
                </div>
                {v.legacy ? <Text role="body-sm" muted as="span">Made before videos were built in, so it can&apos;t be finished from here. Make it again to get a video.</Text> : null}
                {failed[v.folder] ? <span className="action__why video-row__error" role="alert"><Icon icon={Icons.info} size="sm" />{failed[v.folder]}</span> : null}
              </div>
              <div className="row video-row__actions">
                {st.next === "make" ? (
                  <Button size="sm" variant="primary" icon={Icons.video} loading={busy === `make:${v.folder}`} aria-label={`Make video: ${name}`} onClick={() => void make(v)}>Make video</Button>
                ) : null}
                {st.next === "retry" ? (
                  <Button size="sm" variant="primary" icon={Icons.redo} loading={busy === `retry:${v.folder}`} aria-label={`Try again: ${name}`} onClick={() => void retry(v)}>Try again</Button>
                ) : null}
                {st.next === "remake" ? <MakeVideoButton target={targetOfSubject(v.subject)} typeId={v.type} label="Remake" ariaLabel={`Remake: ${name}`} variant="primary" /> : null}
                {v.legacy ? null : <Button size="sm" icon={Icons.video} aria-label={`Open ${name}`} onClick={() => open(v)}>Open</Button>}
                {canRender && !v.legacy && (st.kind === "done" || st.kind === "draft") && (v.draft || v.final) ? (
                  <Button size="sm" variant="ghost" icon={Icons.redo} loading={busy === `render:${v.folder}`} aria-label={`Render again: ${name}`}
                    onClick={() => void run(`render:${v.folder}`, () => bridge.video.render(v.folder, "final"), "Making the final video again")}>Render again</Button>
                ) : null}
                <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`Show ${name} in its folder`} title="Show in folder"
                  onClick={() => void run(`reveal:${v.folder}`, () => bridge.files.reveal(v.folder))} />
                {v.legacy ? null : <Button size="sm" variant="ghost" icon={Icons.trash} className="row-delete" aria-label={`Delete ${name}`} title="Delete" onClick={() => setDeleting(v)} />}
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this video?"
        actions={(
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={!!deleting && busy === `delete:${deleting.folder}`} onClick={() => { if (deleting) void del(deleting); }}>Delete</Button>
          </>
        )}>
        <Text role="body">
          {deleting ? `“${nameOf(deleting)}”` : "This video"} goes with its script and captions. You can undo this, or restore it from Settings › Workspace for 30 days.
        </Text>
      </Dialog>
    </section>
  );
}

export function VideoSections({ videos, recaps, canRender = true }: { videos: VideoListItem[]; recaps: VideoListItem[]; canRender?: boolean }) {
  const by = (s: VideoListItem["section"]) => videos.filter((v) => v.section === s);
  return (
    <div className="stack video-sections">
      <VideoRows items={by("topics")} label={VIDEO_SECTION_LABELS.topics} canRender={canRender} />
      <VideoRows items={by("jobs")} label={VIDEO_SECTION_LABELS.jobs} canRender={canRender} />
      <VideoRows items={by("companies")} label={VIDEO_SECTION_LABELS.companies} canRender={canRender} />
      <VideoRows items={recaps} label={VIDEO_SECTION_LABELS.recaps} canRender={canRender} />
    </div>
  );
}

/**
 * Learn's videos, mounted with one line: every section on the overview, or the topic's own videos on a topic page.
 * When the tools for videos are missing, Render again is locked once here (a plain reason and one click to the
 * Settings › Video panel), never repeated on each row.
 */
export function VideoRegions({ videos, recaps, topic }: { videos: VideoListItem[]; recaps: VideoListItem[]; topic?: string }) {
  const tools = useLoad((b) => b.video.tools(false), [], ["video"]);
  const shown = topic ? videos.filter((v) => v.subject.kind === "topic" && slugOfTopic(v.subject.topic) === topic) : [...videos, ...recaps];
  if (!shown.length) return null;
  const locked = !!tools.data && !tools.data.ok;
  const canRedo = shown.some((v) => v.draft || v.final);
  return (
    <div className="stack">
      {locked && canRedo ? (
        <Card className="row video-locked" aria-label="Video tools">
          <span className="action__why grow"><Icon icon={Icons.locked} size="sm" />Render again needs a few tools this computer doesn&apos;t have yet.</span>
          <Button size="sm" variant="secondary" icon={Icons.settings} onClick={() => navigate({ screen: "settings", tab: "video" })}>Video tools</Button>
        </Card>
      ) : null}
      {topic
        ? <VideoRows items={shown} label="Videos on this topic" canRender={!locked} />
        : <VideoSections videos={videos} recaps={recaps} canRender={!locked} />}
    </div>
  );
}

/** Settings › Video: the tool check (with the same missing-tools card as Make video) and custom video types that failed their check. */
export function VideoSettingsPanel() {
  const bridge = useBridge();
  const words = useWords();
  const { busy, run } = useAction();
  const tools = useLoad((b) => b.video.tools(false), [], ["video"]);
  const types = useLoad((b) => b.video.types("all"), [], ["video", "settings"]);
  if (!tools.data || !types.data) {
    return tools.error || types.error ? <Text role="body" className="make-video__error">{tools.error ?? types.error}</Text> : <Loading />;
  }
  const custom = types.data.types.filter((t) => t.origin === "workspace");
  return (
    <div className="stack">
      {tools.data.ok ? (
        <Card className="stack" role="region" aria-label="Tools for videos">
          <span className="action__why"><Icon icon={Icons.check} size="sm" />Every tool for videos is ready.</span>
          <ul className="list-plain video-tool-list">
            {tools.data.tools.map((t) => (
              <li key={t.id}><Text role="body-sm" muted as="span">{t.label}{t.version ? ` ${t.version}` : ""}{t.ok ? "" : " (optional, not installed)"}</Text></li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="ghost" icon={Icons.redo} loading={busy === "check"}
              onClick={() => void run("check", async () => { await bridge.video.tools(true); tools.reload(); })}>Check again</Button>
          </div>
        </Card>
      ) : <ToolsMissingCard tools={tools.data} onChanged={tools.reload} />}
      <Card className="stack" role="region" aria-label="Custom video types">
        <Text role="heading-2">Custom video types</Text>
        <Text role="body-sm" muted>You can add your own kinds of video. {PRODUCT_NAME} checks your custom video types each time you open Make video.</Text>
        {types.data.errors.length ? (
          <ul className="list-plain">
            {types.data.errors.map((e) => (
              <li key={e.file} className="stack video-type-error">
                <span className="action__why"><Icon icon={Icons.info} size="sm" />{words(friendlyFile(e.file).title) || "A custom video type"} can&apos;t be used yet:</span>
                <ul className="list-plain">{e.problems.map((p, n) => <li key={n}><Text role="body-sm" muted as="span">{words(p) || "It has a problem to fix."}</Text></li>)}</ul>
              </li>
            ))}
          </ul>
        ) : (
          <Text role="body-sm" muted>{custom.length ? `Your custom video types are ready: ${custom.map((t) => words(t.label)).filter(Boolean).join(", ")}.` : "No custom video types."}</Text>
        )}
      </Card>
    </div>
  );
}
