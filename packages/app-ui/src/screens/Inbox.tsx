import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button, Card, cx, Dialog, Icon, Input, Pill, Select, Text, useToast, PRODUCT_NAME, Icons, type IconGlyph, SectionTitle } from "@careeros/brand";
import {
  DOC_KIND_LABEL, JOB_SUBDIRS, LOCKABLE_DIRS, ME_DIRS, type FiledEntry, type FolderSummary, type InboxItem, type InboxTarget, type JobRow, type JobSubdir, type MeDir,
} from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { fmtDay, parseDay, relativeDay } from "../reading/dates";
import { navigate } from "../router";
import { showInFolderLabel } from "../components/files";
import { useFileViewer } from "../viewer";
import { displayName } from "../components/displayName";
import { MiddleTruncate } from "../components/MiddleTruncate";
import { errorSentence } from "../components/ErrorBanner";
import { ErrorState, Loading, ScreenHead } from "../components/States";
import { bytes } from "../format";
import { useClaudeEngine } from "../claude";
import { fillProfileFromDropBox } from "../resumefill";
import "../claude/claude.css";

export function encodeTarget(t: InboxTarget | null): string {
  if (!t) return "";
  return t.kind === "me" ? `me:${t.dir}${t.sub ? `:${t.sub}` : ""}` : `job:${t.company_slug}:${t.id}`;
}

export function decodeTarget(v: string, subdir: JobSubdir): InboxTarget | null {
  const [kind, a, ...rest] = v.split(":");
  if (kind === "me" && a && (ME_DIRS as readonly string[]).includes(a)) {
    const sub = rest.join(":");
    return sub ? { kind: "me", dir: a as MeDir, sub } : { kind: "me", dir: a as MeDir };
  }
  if (kind === "job" && a) {
    const id = rest.join(":");
    if (id) return { kind: "job", company_slug: a, id, subdir };
  }
  return null;
}

const SUBDIR_TEXT: Record<JobSubdir, string> = { "": "Main job folder", application: "Application documents", emails: "Emails", interview: "Interview prep" };
const CONF_TONE = { high: "success", medium: "accent", low: "neutral" } as const;

/** me/identity and me/employment hold sensitive documents and stay locked by default (see Privacy). */
const isLockedMeDir = (d: MeDir) => (LOCKABLE_DIRS as readonly string[]).includes(`me/${d}`);
/** Plain names for the me/ folders, so no raw path reaches the screen. */
export const ME_DIR_TEXT: Record<MeDir, string> = {
  resumes: "Resumes", history: "Work history", projects: "Projects", education: "Education", identity: "Identity documents", employment: "Employment records",
};
/** A job destination in words: "Job: AI Engineer · Application documents". Never a slug or a raw sub-folder name. */
const jobDestText = (t: Extract<InboxTarget, { kind: "job" }>, title?: string) =>
  `Job: ${title ?? "a saved job"}${t.subdir ? ` · ${SUBDIR_TEXT[t.subdir]}` : ""}`;
const destLabel = (t: InboxTarget, title?: string) => (t.kind === "me"
  ? `${ME_DIR_TEXT[t.dir]}${t.sub ? ` · ${t.sub}` : ""}${isLockedMeDir(t.dir) ? " (locked)" : ""}`
  : jobDestText(t, title));

const FOLDER_ICON: Record<string, IconGlyph> = {
  resumes: Icons.file, history: Icons.history, projects: Icons.folder, education: Icons.learn, identity: Icons.locked, employment: Icons.locked,
  companies: Icons.jobs, knowledge: Icons.guide, learning: Icons.learn,
};
const dayOf = (iso: string) => parseDay(iso.slice(0, 10));
// TODO(lane-B): use the shared date helper once format.ts has it.
const when = (iso: string) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? `${fmtDay(d)} · ${relativeDay(d, new Date())}` : ""; };
/** "me/resumes/x.pdf" → "Resumes"; "companies/acme-corp/jobs/…" → "Companies and jobs". */
function areaOf(to: string, folders: FolderSummary[]): string {
  const f = [...folders].sort((a, b) => b.rel.length - a.rel.length).find((x) => to === x.rel || to.startsWith(`${x.rel}/`));
  return f?.label ?? `your ${PRODUCT_NAME} folder`;
}

export function InboxScreen() {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [over, setOver] = useState(false);
  const items = useLoad((b) => b.inbox.list(), [], ["inbox"]);
  const jobs = useLoad((b) => b.jobs.list({ showIneligible: true, limit: 500 }), [], ["jobs"]);
  // A reload can fail (the shared folder became unreadable, a file vanished) while we still hold
  // the last-known list. Show the error and hide every control that would add or file something
  // instead of trusting the stale snapshot.
  const broken = !!items.error;

  const add = (paths: string[]) => run("add", () => bridge.inbox.add(paths), paths.length === 1 ? "Added to your drop box" : `Added ${paths.length} files`);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    const paths = files.map((f) => bridge.pathForFile(f)).filter((p): p is string => !!p);
    if (paths.length < files.length) {
      toast({ tone: "danger", text: `${files.length - paths.length} file(s) couldn't be added. Drag them from Finder or File Explorer.` });
    }
    if (paths.length) void add(paths);
  };
  // `files.pick` resolves to null when the user cancels the OS dialog: that is a silent no-op,
  // never a toast. A toast only fires once the file is actually in the inbox.
  const pick = () => run("pick", async () => {
    const p = await bridge.files.pick();
    if (!p) return;
    await bridge.inbox.add([p]);
    toast({ text: "Added to your drop box", tone: "success" });
  });

  const overview = useLoad((b) => b.inbox.overview(), [], ["inbox", "jobs", "learn", "privacy"]);
  // The names in the confirm are exactly the names sent: main never trashes a file that arrived after it opened.
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const removeNow = (names: string[]) => {
    setConfirm(null);
    void run("remove", () => bridge.inbox.remove(names), names.length === 1 ? `Moved ${displayName(names[0]!)} to the Trash` : `Moved ${names.length} files to the Trash`);
  };
  const waiting = items.data ?? [];
  const viewer = useFileViewer(waiting.map((it) => ({ rel: `inbox/${it.name}`, title: displayName(it.name) })));
  const jobRows = jobs.data?.rows ?? [];
  // File all suggested: the files with a destination the app (or Claude) is fairly sure of. Uses each file's
  // suggestion as shown, not a destination someone changed in its row but didn't file.
  const suggested = waiting.filter((w) => w.suggestion.target && w.suggestion.confidence !== "low");
  const [fileAll, setFileAll] = useState<InboxItem[] | null>(null);
  const fileAllNow = (list: InboxItem[]) => {
    setFileAll(null);
    void run("file-all", async () => {
      const failed: string[] = [];
      for (const it of list) {
        try { await bridge.inbox.file(it.name, it.suggestion.target!, ""); } catch (e) { failed.push(`${displayName(it.name)}: ${errorText(e)}`); }
      }
      const done = list.length - failed.length;
      if (!failed.length) toast({ tone: "success", text: `Filed ${done} ${done === 1 ? "file" : "files"}.` });
      else toast({ tone: "danger", text: `Filed ${done} of ${list.length}. ${failed[0]}` });
    });
  };
  const history = overview.data?.history ?? [];
  // Claude starts on its own only on a subscription. With an API key (or when we can't tell) each look costs
  // credit, so it waits for Ask Claude, and the list says why once.
  const engine = useClaudeEngine().data;
  const askOnly = !!engine?.ready && engine.auth !== "subscription" && waiting.some((w) => w.askable && !w.claude);
  // The big target only while there's nothing yet; once files exist it becomes a strip.
  const empty = !waiting.length && !history.length && !(overview.data?.folders ?? []).some((f) => (f.count ?? 0) > 0);

  return (
    <>
      <ScreenHead title="Drop box" sub={`Drop files in, then file each one where it belongs in your ${PRODUCT_NAME} folder.`} />
      {items.error ? <ErrorState title={items.data ? "The drop box can't be refreshed" : "The drop box can't be shown"} text={errorSentence(items.error)} /> : null}
      {broken ? null : (
        <div className={cx("dropzone", !empty && "dropzone--strip", over && "is-over")} aria-label="Drop files here" role="group" data-tour="inbox-drop"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <Icon icon={Icons.dropBox} />
          <Text role="body">{empty ? "Drop files here, or choose one." : "Drop more files here."}</Text>
          <Button icon={Icons.newFile} loading={busy === "pick" || busy === "add"} onClick={() => void pick()}>Choose file</Button>
        </div>
      )}

      <section className="hub-section" aria-labelledby="dropbox-waiting">
        <SectionTitle icon={Icons.dropBox} title={<>Waiting to be filed{waiting.length ? ` (${waiting.length})` : ""}</>} id="dropbox-waiting"
          status={waiting.length && !broken ? (
            <span className="inbox-bulk">
              {suggested.length ? (
                <Button size="sm" variant="secondary" icon={Icons.check} loading={busy === "file-all"} data-tour="inbox-file-all"
                  title="File every file that has a suggested folder" onClick={() => setFileAll(suggested)}>File all ({suggested.length})</Button>
              ) : null}
              {waiting.length > 1 ? (
                <Button size="sm" variant="ghost" icon={Icons.trash} loading={busy === "remove"} data-tour="inbox-remove-all"
                  onClick={() => setConfirm(waiting.map((w) => w.name))}>Remove all</Button>
              ) : null}
            </span>
          ) : undefined} />
        {jobs.error ? <Text role="body-sm" muted>Job folders can't be listed right now.</Text> : null}
        {askOnly && !broken ? (
          <Text role="body-sm" muted as="p" className="inbox-askonly">
            {`Claude looks at an unsure file only when you ask, because each check ${engine?.auth === "api_key" ? "uses" : "may use"} API credit.`}
          </Text>
        ) : null}
        {!items.data ? (broken ? null : <Loading />) : waiting.length === 0 ? (
          <Card className="stack">
            <div className="row"><Icon icon={Icons.dropBox} /><Text role="heading-2" as="h3">Your drop box is empty</Text></div>
            <Text role="body" muted>Drop a file above, or choose one, and {PRODUCT_NAME} will suggest where it belongs.</Text>
          </Card>
        ) : (
          <div className="stack">
            {waiting.map((it) => (
              <InboxRow key={it.name} item={it} jobs={jobRows} jobsUnavailable={!!jobs.error} readOnly={broken} onRemove={() => setConfirm([it.name])} onView={() => viewer.open(`inbox/${it.name}`)} />
            ))}
          </div>
        )}
      </section>

      {viewer.element}
      <RemoveDialog names={confirm} onCancel={() => setConfirm(null)} onConfirm={removeNow} />
      <FileAllDialog items={fileAll} jobs={jobRows} onCancel={() => setFileAll(null)} onConfirm={fileAllNow} />

      <section className="hub-section" aria-labelledby="dropbox-folders">
        <SectionTitle icon={Icons.folder} title="Your folders" id="dropbox-folders" />
        {overview.error ? <Text role="body-sm" muted>Folder counts can't be shown right now: {overview.error}</Text> : null}
        {overview.data ? <FolderGrid folders={overview.data.folders} /> : overview.error ? null : <Loading />}
      </section>

      <section className="hub-section" aria-labelledby="dropbox-history" data-tour="inbox-history">
        <SectionTitle icon={Icons.history} title="Recently filed" id="dropbox-history" />
        {overview.data ? <History entries={history} folders={overview.data.folders} /> : null}
      </section>
    </>
  );
}

function FolderGrid({ folders }: { folders: FolderSummary[] }) {
  const bridge = useBridge();
  const toast = useToast();
  const show = showInFolderLabel();
  const open = (f: FolderSummary) => {
    if (f.locked) return navigate({ screen: "privacy" });
    if (f.id === "companies") return navigate({ screen: "jobs" });
    if (f.id === "learning") return navigate({ screen: "learn" });
    if (!f.count) return toast({ tone: "neutral", text: `${f.label} is empty. Files you file there will show up here.` });
    void bridge.files.reveal(f.rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }));
  };
  return (
    <ul className="folder-grid" data-tour="inbox-folders">
      {folders.map((f) => {
        const action = f.locked ? "Unlock in Privacy" : f.id === "companies" ? "Open Jobs" : f.id === "learning" ? "Open Learn" : show;
        return (
          <li key={f.id}>
            <button type="button" className={cx("folder-tile", f.locked && "is-locked")} onClick={() => open(f)} title={action}
              aria-label={`${f.label}: ${f.locked ? "locked" : `${f.count ?? 0} ${f.count === 1 ? "file" : "files"}`}. ${action}`}>
              <span className="folder-tile__icon"><Icon icon={FOLDER_ICON[f.id] ?? Icons.folder} /></span>
              <span className="folder-tile__label">{f.label}</span>
              <span className="folder-tile__count">{f.locked ? "Locked" : f.count ? `${f.count} ${f.count === 1 ? "file" : "files"}` : "Empty"}</span>
              {/* One line of meta only when it adds something: "Empty" already says there's nothing yet. */}
              {f.locked || f.updated ? <span className="folder-tile__meta">{f.locked ? "Not read while locked" : `Updated ${fmtDay(new Date(f.updated))}`}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function History({ entries, folders }: { entries: FiledEntry[]; folders: FolderSummary[] }) {
  const bridge = useBridge();
  const toast = useToast();
  const show = showInFolderLabel();
  const viewer = useFileViewer(entries.map((e) => ({ rel: e.to, title: displayName(e.name), at: e.at })));
  if (!entries.length) return <Text role="body" muted>History starts from now: every file you file here will be listed with where it went.</Text>;
  return (
    <>
    <ul className="list-plain filed-list" aria-label="Filing history">
      {entries.map((e, i) => (
        <li key={`${e.at}-${e.name}-${i}`} className="filed-list__item">
          <Icon icon={Icons.file} size="sm" />
          <span className="filed-list__main">
            <Text role="body" as="span"><MiddleTruncate text={displayName(e.name)} /></Text>
            <Text role="body-sm" muted as="span">to {areaOf(e.to, folders)}{e.note ? ` · ${displayName(e.note)}` : ""}</Text>
          </span>
          <Text role="body-sm" muted as="span" className="filed-list__when" title={e.at}>{dayOf(e.at) ? when(e.at) : ""}</Text>
          <Button size="sm" variant="ghost" icon={Icons.show} title="View" aria-label={`View ${displayName(e.name)}`} onClick={() => viewer.open(e.to)} />
          <Button size="sm" variant="ghost" icon={Icons.showInFolder} title={show} aria-label={`${show}: ${displayName(e.name)}`}
            onClick={() => void bridge.files.reveal(e.to).catch((err: unknown) => toast({ tone: "danger", text: errorText(err) }))} />
        </li>
      ))}
    </ul>
    {viewer.element}
    </>
  );
}

/** One confirm for Remove and Remove all. Files go to the Trash, so the copy says they can come back. */
function RemoveDialog({ names, onCancel, onConfirm }: { names: string[] | null; onCancel: () => void; onConfirm: (names: string[]) => void }) {
  const list = names ?? [];
  const one = list.length === 1;
  const SHOWN = 6;
  return (
    <Dialog open={!!names} onClose={onCancel} title={one ? `Remove ${displayName(list[0]!)}?` : `Remove all ${list.length} files?`}
      actions={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" icon={Icons.trash} onClick={() => onConfirm(list)}>{one ? "Trash file" : `Trash ${list.length} files`}</Button>
      </>}>
      <Text role="body">{one ? "It goes to the Trash, so you can still get it back." : "They go to the Trash, so you can still get them back."}</Text>
      {one ? null : (
        <ul className="list-plain remove-list">
          {list.slice(0, SHOWN).map((n) => <li key={n}><MiddleTruncate text={displayName(n)} /></li>)}
          {list.length > SHOWN ? <li><Text role="body-sm" muted as="span">and {list.length - SHOWN} more</Text></li> : null}
        </ul>
      )}
    </Dialog>
  );
}

/** One confirm for File all suggested: every file and where it goes, in words. */
function FileAllDialog({ items, jobs, onCancel, onConfirm }: { items: InboxItem[] | null; jobs: JobRow[]; onCancel: () => void; onConfirm: (items: InboxItem[]) => void }) {
  const list = items ?? [];
  const n = list.length;
  const title = (t: InboxTarget) => (t.kind === "job" ? jobs.find((j) => j.company_slug === t.company_slug && j.id === t.id)?.title : undefined);
  return (
    <Dialog open={!!items} onClose={onCancel} title={`File ${n} suggested ${n === 1 ? "file" : "files"}?`}
      actions={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onConfirm(list)}>{`File ${n} ${n === 1 ? "file" : "files"}`}</Button>
      </>}>
      <Text role="body">Each file goes where its suggestion says. Files you're unsure about stay here.</Text>
      <ul className="list-plain file-all-list">
        {list.map((it) => (
          <li key={it.name} className="file-all-list__item">
            <MiddleTruncate text={displayName(it.name)} className="file-all-list__name" />
            <Text role="body-sm" muted as="span" className="file-all-list__to">to {destLabel(it.suggestion.target!, title(it.suggestion.target!))}</Text>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Add as a job: the company and title, prefilled from the ad, then one click. */
function AddJobDialog({ item, onClose }: { item: InboxItem | null; onClose: () => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (item) { setCompany(item.job?.company ?? ""); setTitle(item.job?.title ?? ""); }
  }, [item]);
  const ready = company.trim() && title.trim();
  const add = () => run("add-job", async () => {
    const r = await bridge.inbox.addAsJob(item!.name, { company: company.trim(), title: title.trim() });
    onClose();
    toast({
      tone: "success", text: `Added ${title.trim()} at ${company.trim()}.`,
      action: { label: "Open job", onClick: () => navigate({ screen: "job", slug: r.job.company_slug, id: r.job.id }) },
    });
  });
  return (
    <Dialog open={!!item} onClose={onClose} title="Add this job ad as a job"
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={Icons.add} disabled={!ready} loading={busy === "add-job"} aria-describedby={ready ? undefined : "add-job-why"}
          onClick={() => void add()}>Add job</Button>
      </>}>
      <div className="stack">
        <Text role="body">The ad's text is saved as the job's description, and this file goes into the new job's folder.</Text>
        <Input label="Company" value={company} maxLength={120} onChange={(e) => setCompany(e.target.value)} />
        <Input label="Job title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        {ready ? null : <Text role="body-sm" muted id="add-job-why">Fill in the company and the job title.</Text>}
      </div>
    </Dialog>
  );
}

/**
 * Claude's part of a row, in one fixed-size slot so nothing moves: Ask Claude, a running chip, or a failed note with
 * Try again. Nothing shows for files Claude may not see (locked folders) or doesn't need to.
 */
function ClaudeSlot({ item, onAsk, asking }: { item: InboxItem; onAsk: () => void; asking: boolean }) {
  const c = item.claude;
  let body: ReactNode = null;
  if (c?.state === "running") {
    body = (
      <span className="rchip rchip--running" role="status">
        <span className="rchip__main"><span className="rchip__spin" aria-hidden="true" /><span className="rchip__text">Claude is reading it</span></span>
      </span>
    );
  } else if (c?.state === "failed" && item.askable) {
    body = (
      <span className="rchip rchip--failed" title={c.error}>
        <span className="rchip__main"><span className="rchip__dot" aria-hidden="true" /><span className="rchip__text">Claude couldn't decide</span></span>
        <Button size="sm" variant="ghost" className="rchip__btn" loading={asking} onClick={onAsk} aria-label={`Ask Claude again about ${displayName(item.name)}`}>Try again</Button>
      </span>
    );
  } else if (item.askable && c?.state !== "done") {
    body = <Button size="sm" variant="ghost" icon={Icons.ai} loading={asking} onClick={onAsk} data-tour="inbox-ask-claude">Ask Claude</Button>;
  }
  return <span className="inbox-claude">{body}</span>;
}

function InboxRow({ item, jobs, jobsUnavailable, readOnly, onRemove, onView }: { item: InboxItem; jobs: JobRow[]; jobsUnavailable: boolean; readOnly: boolean; onRemove: () => void; onView: () => void }) {
  const bridge = useBridge();
  const toast = useToast();
  const show = showInFolderLabel();
  const { busy, run } = useAction();
  const s = item.suggestion.target;
  const [dest, setDest] = useState(encodeTarget(s));
  const [subdir, setSubdir] = useState<JobSubdir>(s?.kind === "job" ? s.subdir ?? "" : "");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const helpId = useId();
  // A later suggestion (Claude's answer) replaces the destination, unless the person already chose one.
  const touched = useRef(false);
  const sugKey = `${encodeTarget(s)}|${s?.kind === "job" ? s.subdir ?? "" : ""}`;
  useEffect(() => {
    if (touched.current) return;
    setDest(encodeTarget(s));
    setSubdir(s?.kind === "job" ? s.subdir ?? "" : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugKey]);

  const options = [
    { value: "", label: "Choose a folder" },
    ...(s?.kind === "me" && s.sub ? [{ value: encodeTarget(s), label: destLabel(s) }] : []),
    ...ME_DIRS.map((d) => ({ value: `me:${d}`, label: destLabel({ kind: "me", dir: d }) })),
    ...jobs.map((j) => ({ value: `job:${j.company_slug}:${j.id}`, label: `Job: ${j.title} · ${j.company_name}` })),
  ];
  const target = decodeTarget(dest, subdir);
  const locked = target?.kind === "me" && isLockedMeDir(target.dir);
  // A resume can fill the profile, unless the person chose a locked folder for it: then it stays put.
  const canFill = item.kind === "resume" && !locked;
  const file = () => run(`file-${item.name}`, () => bridge.inbox.file(item.name, target!, note.trim()), `Filed ${item.name}`);
  const ask = () => run(`ask-${item.name}`, () => bridge.inbox.ask(item.name));
  // A job ad that isn't a saved job yet: adding it as a job is the main action; filing it somewhere stays possible.
  const jobAd = item.kind === "job_ad" && !s;
  const putBack = () => run(`back-${item.name}`, async () => {
    const r = await bridge.inbox.putBack(item.name);
    toast({ tone: "success", text: r.text });
  });

  const shownName = displayName(item.name);
  // Help for the row sits under the whole row, so the fields and File it share one baseline.
  const help = [
    jobsUnavailable ? "Job folders aren't available right now, so they're missing from this list." : "",
    !target ? (jobAd ? "To file it somewhere else instead, choose a folder, then File it." : "Choose where this file goes, then File it.") : "",
  ].filter(Boolean).join(" ");

  return (
    <Card aria-label={shownName} className="stack inbox-item">
      <div className="inbox-item__head">
        <Icon icon={Icons.file} size="sm" />
        <Text role="body" as="span" className="inbox-item__name"><MiddleTruncate text={shownName} /></Text>
        <Text role="body-sm" muted as="span" className="inbox-item__meta">{bytes(item.size)}{item.from ? ` · from ${item.from}` : ""}</Text>
        <span className="inbox-item__actions">
          <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${shownName}`} onClick={onView}>View</Button>
          <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label={`${show}: ${shownName}`}
            onClick={() => void bridge.files.reveal(`inbox/${item.name}`).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }))}>{show}</Button>
          {readOnly ? null : (
            <>
              {item.from ? (
                <Button size="sm" variant="ghost" icon={Icons.putBack} loading={busy === `back-${item.name}`} data-tour="inbox-put-back"
                  aria-label={`Put back in ${item.from}`} title={`Return ${shownName} to ${item.from}`} onClick={() => void putBack()}>Put back</Button>
              ) : null}
              <Button size="sm" variant="ghost" icon={Icons.trash} aria-label={`Remove ${shownName}`} data-tour="inbox-remove" onClick={onRemove}>Remove</Button>
            </>
          )}
        </span>
      </div>
      <div className="row inbox-suggestion" data-tour="inbox-suggestion">
        <Pill tone={!s ? "neutral" : item.suggestion.by === "claude" ? "accent" : CONF_TONE[item.suggestion.confidence]}>
          {item.suggestion.confidence === "low" || !s ? "No suggestion" : item.suggestion.by === "claude" ? "Suggested by Claude" : "Suggested"}
        </Pill>
        {item.kind && item.kind !== "other" ? <Pill tone="neutral">{DOC_KIND_LABEL[item.kind]}</Pill> : null}
        {s ? <Text role="body-sm" className="t-strong">{destLabel(s, s.kind === "job" ? jobs.find((j) => j.company_slug === s.company_slug && j.id === s.id)?.title : undefined)}</Text> : null}
        <Text role="body-sm" muted>{item.suggestion.reason}</Text>
        {locked ? <Pill tone="warning">Locked folder</Pill> : null}
        {/* The slot is there only for files Claude may look at, so a locked file's row has no empty gap. */}
        {readOnly || !(item.askable || item.claude) ? null : <ClaudeSlot item={item} onAsk={() => void ask()} asking={busy === `ask-${item.name}`} />}
      </div>
      {readOnly ? null : (
        <div className="inbox-form" data-tour="inbox-file">
          <div className={cx("inbox-form__row", dest.startsWith("job:") && "has-subdir")}>
            <Select label="Destination" value={dest} onChange={(e) => { touched.current = true; setDest(e.target.value); }} options={options} aria-describedby={help ? helpId : undefined} />
            {dest.startsWith("job:") ? (
              <Select label="Job folder" value={subdir} onChange={(e) => { touched.current = true; setSubdir(e.target.value as JobSubdir); }}
                options={JOB_SUBDIRS.map((d) => ({ value: d, label: SUBDIR_TEXT[d] }))} />
            ) : null}
            <Input label="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            <span className="inbox-form__actions">
              {jobAd ? <Button variant="primary" icon={Icons.add} data-tour="inbox-add-job" onClick={() => setAdding(true)}>Add job</Button> : null}
              <Button variant={jobAd ? "secondary" : "primary"} disabled={!target} loading={busy === `file-${item.name}`} aria-describedby={!target ? helpId : undefined}
                onClick={() => void file()}>File it</Button>
            </span>
          </div>
          {help || canFill ? (
            <div className="inbox-form__foot">
              {help ? <Text role="body-sm" muted id={helpId} className="inbox-form__help">{help}</Text> : <span />}
              {canFill ? (
                <Button size="sm" variant="ghost" icon={Icons.next} title={`Fill your profile from ${shownName}. It's read on this computer.`}
                  onClick={() => fillProfileFromDropBox(item.name)}>Fill profile</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <AddJobDialog item={adding ? item : null} onClose={() => setAdding(false)} />
    </Card>
  );
}
