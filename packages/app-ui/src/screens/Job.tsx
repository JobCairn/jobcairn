import { useEffect, useState } from "react";
import { Badge, Button, cx, Icons, Pill, Select, Tabs, Text, Textarea, useToast } from "@careeros/brand";
import { JOB_STATUSES, WR_LABEL_TEXT, topicLabel, topicSlug, type ActionTarget, type JobDetail, type JobFile, type JobStatus, type SponsorshipFocus, type WorkRightsLabel } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { ActionButton } from "../components/ActionButton";
import { MakeVideoButton } from "../components/MakeVideo";
import { displayName } from "../components/displayName";
import { JobErrorBanner } from "../components/ErrorBanner";
import { JobMail } from "../components/JobMail";
import { friendlyFile, showInFolderLabel } from "../components/files";
import { Markdown } from "../components/Markdown";
import { parseJd } from "../reading/jd";
import { KeyFacts } from "../reading/KeyFacts";
import { EmptyState, Loading } from "../components/States";
import { useCandidate, rightsTone } from "../candidate";
import { bytes } from "../format";
import { fmtWhen, fmtDayOf } from "../reading/dates";
import { ListenButton } from "../listen";
import { EditResumeButton } from "../resume/EditResumeButton";
import { navigate, toHash, type Route } from "../router";
import { SourceBadge } from "../source/SourceBadge";
import { ScorePanel } from "../score/ScorePanel";
import { KeywordGapCard } from "../score/KeywordGap";
import { JobActivity, useJobRunCount } from "../claude";
import { BackLink, usePageName } from "../nav";
import { JobVideosPanel, useJobVideos } from "../video/JobVideos";
import { JobSponsor } from "../jobs/JobSponsor";
import { GhostPills } from "../jobs/GhostPills";
import { ClosingBadge } from "../jobs/ClosingBadge";
import { PayBenchmark } from "../jobs/PayBenchmark";
import { FollowUpDate, InterviewDate } from "../jobs/JobCalendar";
import { FreshBadge } from "../jobs/FreshBadge";
import { OutreachPanel } from "../outreach/OutreachPanel";
import { useFileViewer } from "../viewer";
import { MoreMenu } from "../mail/MoreMenu";
import { useDelete } from "../trash";

/** The job page's main button follows where the application is. */
const APPLY_TEXT: Record<JobStatus, { label: string; primary: boolean }> = {
  Found: { label: "Prepare application", primary: true }, Saved: { label: "Prepare application", primary: true },
  Applying: { label: "Continue application", primary: true }, Applied: { label: "View application", primary: false },
  Interview: { label: "View application", primary: false }, Offer: { label: "View application", primary: false },
  Rejected: { label: "View application", primary: false }, Skipped: { label: "Prepare application", primary: false },
};

const TABS = ["description", "score", "files", "videos", "timeline", "gaps", "interview", "activity", "mail", "outreach"] as const;
type Tab = (typeof TABS)[number];

export function JobScreen({ route }: { route: Route }) {
  if (route.screen !== "job") return <Loading />;
  return <><BackLink route={route} /><JobView slug={route.slug} id={route.id} tab={(TABS as readonly string[]).includes(route.tab ?? "") ? (route.tab as Tab) : "description"} start={!!route.start} /></>;
}

function JobView({ slug, id, tab, start }: { slug: string; id: string; tab: Tab; start: boolean }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const [note, setNote] = useState("");
  const { data: d, error } = useLoad((b) => b.jobs.get(slug, id), [slug, id], ["jobs", "settings"]);
  const candidate = useCandidate();
  const running = useJobRunCount(slug, id);
  const videos = useJobVideos(slug, id);
  const videoCount = videos.items?.length ?? 0;
  const del = useDelete();
  const viewer = useFileViewer((d?.files ?? []).filter((f) => f.exists).map((f) => ({ rel: f.rel, title: jobFileTitle(f), at: f.at })));
  usePageName(d?.job.title);
  // `start=1` is one-shot: drop it from the address (replaceState fires no hashchange, so this view keeps it) so
  // Back and reload never score again.
  useEffect(() => {
    if (!start) return;
    try { window.history.replaceState(window.history.state, "", toHash({ screen: "job", slug, id, tab })); } catch { /* not in a browser */ }
  }, [start, slug, id, tab]);

  if (error && !d) return <JobErrorBanner error={error} />;
  if (!d || !candidate) return <Loading />;
  // A reload can fail (the job was deleted, or the file became unreadable) while we still hold
  // the last-known data. Show the error and hide every mutating action instead of pretending the
  // stale snapshot is current.
  const broken = !!error;
  const j = d.job;
  const base = `companies/${slug}/jobs/${id}`;
  const url = [j.apply_via, j.url].find((u) => u.startsWith("https://"));
  const job: ActionTarget = { kind: "job", company_slug: slug, id };
  const score = scoreState(d);
  const focus = candidate.focus;
  const rightsPill = rightsTone(j.work_rights.label, focus);

  const setStatus = (s: JobStatus) => run("status", () => bridge.jobs.setStatus(slug, id, s, ""), `Status set to ${s}`);
  const addNote = () => run("note", async () => { await bridge.jobs.addNote(slug, id, note.trim()); setNote(""); });
  const attach = () => run("attach", async () => {
    const p = await bridge.files.pick();
    if (!p) return;
    await bridge.jobs.attach(slug, id, p, p.split(/[\\/]/).pop() ?? "File", "");
    toast({ text: "File attached", tone: "success" });
  });

  return (
    <>
      {broken ? <JobErrorBanner error={error} /> : null}
      <header className="job-head">
        <div className="job-head__main">
          {/* Long titles wrap to two lines; the full title stays in the tooltip and the window's title. */}
          <h1 className={cx("t-display", "job-head__title", j.title.length > 48 && "job-head__title--long")} title={j.title}>{j.title}</h1>
          <div className="row job-head__meta" data-tour="job-meta">
            <Text role="body" muted>{d.company ? <a className="company-link" href={`#/company/${d.company.slug}`} title={`Open ${d.company.name}`}>{d.company.name}</a> : slug}{j.client ? ` · client ${j.client}` : ""} · {[j.location, j.work_mode].filter(Boolean).join(" · ")}</Text>
            <SourceBadge job={j} size="sm" showName />
            <FreshBadge row={j} />
            <ClosingBadge row={j} />
            {rightsPill ? <Pill tone={rightsPill}>{WR_LABEL_TEXT[j.work_rights.label]}</Pill> : null}
            {!d.eligible ? <Pill tone="danger">You can't apply</Pill> : null}
            <GhostPills ghost={d.ghost} />
          </div>
        </div>
        {broken ? null : (
          <div className="job-head__actions">
            <div className="inline-field" data-tour="job-status">
              <span className="inline-field__label" aria-hidden="true">Status</span>
              <Select label="Status" hideLabel value={j.status} onChange={(e) => void setStatus(e.target.value as JobStatus)} options={JOB_STATUSES.map((s) => ({ value: s, label: s }))} />
            </div>
            {url ? <Button icon={Icons.openExternal} onClick={() => void bridge.links.open(url)}>Open ad</Button> : null}
            <MakeVideoButton target={job} size="md" />
            <Button data-tour="job-apply" variant={APPLY_TEXT[j.status].primary ? "primary" : "secondary"} icon={Icons.apply} onClick={() => navigate({ screen: "apply", slug, id })}>{APPLY_TEXT[j.status].label}</Button>
            <MoreMenu label="More job actions" size="md" items={[{
              id: "delete", label: "Delete job", tone: "danger",
              // Leave the page first: its reload would otherwise show the "job was deleted" error. Undo comes back.
              onSelect: () => del.ask([{ kind: "job", company_slug: slug, id }], { label: "Delete job", onDeleted: () => navigate({ screen: "jobs" }), onRestored: () => navigate({ screen: "job", slug, id }) }),
            }]} />
          </div>
        )}
      </header>

      <Tabs label="Job sections" value={tab} onChange={(t) => navigate({ screen: "job", slug, id, tab: t })}
        tabs={[
          { id: "description", label: "Description" }, { id: "score", label: "Score" }, { id: "files", label: "Files", count: d.files.length },
          { id: "videos", label: "Videos", count: videoCount },
          { id: "timeline", label: "Timeline", count: j.timeline.length }, { id: "gaps", label: "Gaps", count: d.gaps.length }, { id: "interview", label: "Interview" },
          { id: "activity", label: "Activity", count: running, countLabel: running ? `${running} running` : undefined },
          { id: "mail", label: "Mail" },
          { id: "outreach", label: "Outreach" },
        ]}>
        {tab === "description" ? (
          <div className="stack">
            {/* Claude actions are mutations (they write a request), so a broken job hides them like every other control. */}
            {broken ? <div className="row" data-tour="job-listen"><ListenButton title={`Job description: ${j.title}`} text={d.description} target="listen-jd" source={`${base}/jd.md`} /><ListenButton title={`Company research: ${d.company?.name ?? slug}`} label="Hear research" source={`companies/${slug}/research.md`} missingText="No company research yet. Use Research company first." /></div> : (
              <div className="action-bar" role="group" aria-label="Ask Claude" data-tour="job-ask">
                <ActionButton action="research_company" target={job} />
                <span className="action-bar__sep" aria-hidden="true" />
                <span className="action-bar__group" data-tour="job-listen"><ListenButton title={`Job description: ${j.title}`} text={d.description} target="listen-jd" source={`${base}/jd.md`} /><ListenButton title={`Company research: ${d.company?.name ?? slug}`} label="Hear research" source={`companies/${slug}/research.md`} missingText="No company research yet. Use Research company first." /></span>
                <span className="action-bar__sep" aria-hidden="true" />
                <ActionButton action="jd_walkthrough_video" target={job} variant="ghost" />
                <ActionButton action="company_background_video" target={job} variant="ghost" />
              </div>
            )}
            <PayBenchmark d={d} />
            <JobSponsor job={j} focus={focus} />
            {d.description ? <div id="listen-jd"><JobDescription text={d.description} baseDir={base} title={j.title} rights={j.work_rights.label} focus={focus} /></div> : <EmptyState text="No description saved for this job." />}
          </div>
        ) : null}
        {tab === "activity" ? <JobActivity slug={slug} id={id} /> : null}
        {tab === "score" ? (
          <div className="stack">
            <ScorePanel d={d} base={base} target={broken ? null : { kind: "job", company_slug: slug, id }} focus={focus} autoStart={start} />
            <KeywordGapCard jd={d.description} files={d.files} target={broken ? null : { kind: "job", company_slug: slug, id }} />
          </div>
        ) : null}
        {tab === "files" ? (
          <div className="stack job-panel">
            <ul className="list-plain" data-tour="job-files">
              {d.files.map((f) => (
                <li key={f.rel} className="row job-file">
                  <JobFileRow f={f} onOpen={f.exists ? () => viewer.open(f.rel) : undefined} />
                  {f.exists ? <Button size="sm" variant="ghost" icon={Icons.show} aria-label={`View ${jobFileTitle(f)}`} onClick={() => viewer.open(f.rel)}>View</Button> : null}
                  {f.exists ? <Button size="sm" variant="ghost" icon={Icons.showInFolder} title={showInFolderLabel()} aria-label={`${showInFolderLabel()}: ${f.label}`} onClick={() => void bridge.files.reveal(f.rel)}>{showInFolderLabel()}</Button> : <Pill tone="warning">Missing</Pill>}
                  {broken || !f.exists || !deletableFile(f) ? null : (
                    <MoreMenu label={`More actions: ${jobFileTitle(f)}`} items={[{ id: "delete", label: "Delete file", tone: "danger",
                      onSelect: () => del.ask([{ kind: "job_file", company_slug: slug, id, path: f.path }], { label: "Delete file" }) }]} />
                  )}
                </li>
              ))}
            </ul>
            {viewer.element}
            {broken ? null : <div className="row"><Button icon={Icons.attach} loading={busy === "attach"} onClick={() => void attach()}>Attach file</Button><EditResumeButton slug={slug} id={id} files={d.files} size="md" /></div>}
          </div>
        ) : null}
        {tab === "timeline" ? (
          <div className="stack job-panel">
            {broken ? null : <FollowUpDate d={d} />}
            <ul className="list-plain timeline">
              {[...j.timeline].reverse().map((e, i) => (
                <li key={`${e.at}-${i}`}><Text role="body-sm" muted>{fmtWhen(e.at) || e.at}</Text><span><Text role="body" as="div">{e.event}</Text>{e.note ? <Text role="body-sm" muted as="div">{e.note}</Text> : null}</span></li>
              ))}
            </ul>
            {broken ? null : (
              <>
                <Textarea label="Add a note" value={note} maxLength={2000} placeholder="Type a note to add it to the timeline" onChange={(e) => setNote(e.target.value)} />
                <div className="row">
                  <Button disabled={!note.trim()} aria-describedby={note.trim() ? undefined : "note-why"} loading={busy === "note"} onClick={() => void addNote()}>Add note</Button>
                  {note.trim() ? null : <Text role="body-sm" muted id="note-why">Type a note first.</Text>}
                </div>
              </>
            )}
          </div>
        ) : null}
        {tab === "gaps" ? (
          d.gaps.length ? (
            <ul className="list-plain job-panel">
              {d.gaps.map((g) => (
                <li key={g} className="row row--between"><Text role="body">{g}</Text>
                  <div className="row">
                    <Button size="sm" aria-label={`Study ${g}`} onClick={() => navigate({ screen: "learn", topic: topicSlug(g) })}>Study</Button>
                    {/* The gap name comes from an ad: topicLabel keeps only plain characters before it reaches a prompt. */}
                    {broken ? null : (
                      <ActionButton action="skill_gap_video" target={{ kind: "topic", topic: topicSlug(g), label: topicLabel(g), company_slug: slug, id }}
                        ariaLabel={`Lesson video: ${displayName(g)}`} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState text={score.scored ? "No skill gaps were found when this job was scored." : "Not scored yet. Score this job to find the skills it asks for that you haven't shown."}
              action={!score.scored && !broken ? <ActionButton action="score_job" target={job} variant="primary" /> : undefined} />
          )
        ) : null}
        {tab === "interview" ? (
          <div className="stack job-panel">
            <InterviewDate d={d} readOnly={broken} />
            <Text role="body" muted>Claude writes practice material into this job&apos;s interview folder. Watch and read it in Learn.</Text>
            {broken ? null : (
              <div className="action-bar" role="group" aria-label="Ask Claude">
                <ActionButton action="interview_prep" target={job} />
                <span className="action-bar__sep" aria-hidden="true" />
                <ActionButton action="interview_prep_video" target={job} variant="ghost" />
                <ActionButton action="pitch_video" target={job} variant="ghost" />
              </div>
            )}
            <div><Button icon={Icons.learn} onClick={() => navigate({ screen: "learn", job: `${slug}/${id}` })}>Open Learn</Button></div>
            {videoCount ? (
              <div><Button variant="ghost" icon={Icons.video} onClick={() => navigate({ screen: "job", slug, id, tab: "videos" })}>{`Videos (${videoCount})`}</Button></div>
            ) : null}
          </div>
        ) : null}
        {tab === "videos" ? <JobVideosPanel slug={slug} id={id} items={videos.items} error={videos.error} canMake={!broken} /> : null}
        {tab === "mail" ? <JobMail slug={slug} id={id} files={d.files} /> : null}
        {tab === "outreach" ? <OutreachPanel slug={slug} id={id} d={d} broken={broken} /> : null}
      </Tabs>
      {del.element}
    </>
  );
}

/** The job's own record and ad stay with the job; everything else listed in Files (a cover letter, an attachment) can go. */
const deletableFile = (f: JobFile) => f.path !== "jd.md" && f.path !== "job.json" && !f.path.startsWith("emails/");

const jobFileTitle = (f: JobFile) => (f.label === f.path.split("/").pop() ? friendlyFile(f.path, f.at).title : f.label);

/** One Files row: the name and "Text · 2 KB · 8 Oct 2026". Clicking it opens the file in the viewer. */
function JobFileRow({ f, onOpen }: { f: JobFile; onOpen?: () => void }) {
  const title = <Text role="body" truncate as="div" className="file-open__title">{jobFileTitle(f)}</Text>;
  const meta = <Text role="body-sm" muted as="div">{[friendlyFile(f.path).type, f.size !== null ? bytes(f.size) : "", f.at ? fmtDayOf(f.at) : ""].filter(Boolean).join(" · ")}</Text>;
  if (!onOpen) return <span className="grow">{title}{meta}</span>;
  return <span className="grow"><button type="button" className="file-open" tabIndex={-1} aria-hidden="true" onClick={onOpen}>{title}{meta}</button></span>;
}

/** The ad as a reading view: key facts first, then the ad itself at a comfortable measure. */
function JobDescription({ text, baseDir, title, rights, focus }: { text: string; baseDir: string; title: string; rights: WorkRightsLabel; focus: SponsorshipFocus }) {
  const jd = parseJd(text, title);
  return (
    <article className="reading">
      {/* Room for a small listen control (read-aloud) beside the reading view. */}
      <div className="reading__tools" data-slot="listen" />
      {jd.facts.length ? <KeyFacts facts={jd.facts} rights={rights} focus={focus} /> : null}
      <Markdown text={jd.body} baseDir={baseDir} />
    </article>
  );
}

/** One reading of "is this job scored?" for the Score and Gaps tabs (a fit, a career match or a report). */
export function scoreState(d: JobDetail): { scored: boolean; when: string } {
  const s = d.job.scores;
  const event = [...d.job.timeline].reverse().find((e) => /^scored\b/i.test(e.event));
  const scored = s.fit.value !== null || s.career.match !== null || !!d.scoreReport;
  return { scored, when: s.career.scored_at || event?.at || "" };
}
