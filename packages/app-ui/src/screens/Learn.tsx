import { useEffect, useMemo, useState } from "react";
import { Button, Card, Icon, Icons, Input, Text, PRODUCT_NAME, SectionTitle } from "@careeros/brand";
import { learnHistory, topicLabel, type ActionTarget, type LearnEntry, type LearnHub, type LearnType, type SkillSuggestion } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { displayName } from "../components/displayName";
import { errorSentence } from "../components/ErrorBanner";
import { WORKSPACE } from "../components/ActionButton";
import { MakeVideoButton } from "../components/MakeVideo";
import { ErrorState, Loading, ScreenHead } from "../components/States";
import { BackLink } from "../nav";
import { VideoRegions } from "../components/VideoList";
import { fmtDate } from "../format";
import { GettingStarted, NextStep } from "../guide";
import { useClaudeEngine } from "../claude";
import { LearnCard, TYPE_TEXT } from "../learn/LearnCard";
import { MoreMenu } from "../mail/MoreMenu";
import { useDelete } from "../trash";
import { Reader } from "../learn/Reader";
import { TopicVideoActions } from "../learn/TopicVideo";
import { StartTopicDialog } from "../learn/StartTopicDialog";
import { JobsToLearn, NextTopics, SuggestedTopics } from "../learn/Suggestions";
import { RunButton } from "../learn/RunButton";
import { StudyRuns } from "../learn/StudyRuns";
import "../learn/learn.css";
import { CLAUDE_SETTINGS, navigate, type Route } from "../router";

type Filter = "all" | LearnType;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" }, { id: "guide", label: "Guides" }, { id: "video", label: "Videos" }, { id: "interview", label: "Interview prep" },
];

/** How many topics count as "few": below this, the list ends with what to study next instead of empty space. */
const FEW_TOPICS = 4;

function Library({ hub, onOpen, onGuide }: { hub: LearnHub; onOpen: (e: LearnEntry) => void; onGuide: (skill: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return hub.entries.filter((e) => (filter === "all" || e.type === filter)
      && (!needle || `${e.title} ${e.source?.title ?? ""} ${e.source?.company_name ?? ""}`.toLowerCase().includes(needle)));
  }, [hub.entries, filter, q]);
  const count = (f: Filter) => (f === "all" ? hub.entries.length : hub.entries.filter((e) => e.type === f).length);

  return (
    <section className="learn-section" aria-labelledby="library-title">
      <div className="learn-section__head learn-section__head--row">
        <SectionTitle icon={Icons.guide} title="Your topics" id="library-title" />
        <div className="learn-tools">
          <div className="learn-filter" role="group" aria-label="Show" data-tour="learn-filter">
            {/* A type with nothing in it isn't offered (unless it's the one selected), so the filter only lists what exists. */}
            {FILTERS.filter((f) => f.id === "all" || f.id === filter || count(f.id) > 0).map((f) => (
              <button key={f.id} type="button" className="learn-filter__item" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span className="learn-filter__count">{count(f.id)}</span>
              </button>
            ))}
          </div>
          <div className="learn-search">
            <Input label="Search your topics" hideLabel placeholder="Search topics and jobs" value={q} onChange={(e) => setQ(e.target.value)} type="search" />
          </div>
        </div>
      </div>
      {shown.length ? (
        <div className="learn-grid" data-tour="learn-topics">{shown.map((e) => <LearnCard key={e.path} entry={e} onOpen={onOpen} />)}</div>
      ) : (
        <Text role="body" muted>
          {q.trim() ? `Nothing matches "${q.trim()}".` : `No ${filter === "all" ? "items" : TYPE_TEXT[filter as LearnType].toLowerCase()} yet.`}
        </Text>
      )}
      {hub.entries.length < FEW_TOPICS && !q.trim() ? <NextTopics suggestions={hub.suggestions} onGuide={onGuide} /> : null}
    </section>
  );
}

function History({ entries, onOpen }: { entries: LearnEntry[]; onOpen: (e: LearnEntry) => void }) {
  const done = learnHistory(entries);
  return (
    <Card className="stack" aria-labelledby="history-title" data-tour="learn-history">
      <SectionTitle icon={Icons.history} title="History" id="history-title" />
      {done.length ? (
        <ol className="list-plain history">
          {done.map((e) => (
            <li key={e.path} className="history__row">
              <span className="history__date t-numeric t-muted">{fmtDate(e.progress_at) || "Done"}</span>
              <button type="button" className="link-button" onClick={() => onOpen(e)} title={displayName(e.title)}>{displayName(e.title)}</button>
              <span className="t-body-sm t-muted">{TYPE_TEXT[e.type]}</span>
            </li>
          ))}
        </ol>
      ) : <Text role="body-sm" muted>Finished guides land here. Open one and tick "I've finished this".</Text>}
    </Card>
  );
}

/**
 * Said once for the whole screen when Claude isn't set up, instead of on every button: guides, interview prep
 * and job scores all need it. The buttons stay, so the person sees what becomes possible.
 */
function ClaudeNotice() {
  const engine = useClaudeEngine();
  if (!engine.data || engine.data.ready) return null;
  return (
    <div className="learn-claude" role="note">
      <Icon icon={Icons.ai} />
      <Text role="body-sm" as="p" className="grow">Claude isn't set up yet. It writes the guides, interview prep and job scores on this page.</Text>
      <Button size="sm" variant="primary" onClick={() => navigate(CLAUDE_SETTINGS)}>Claude setup</Button>
    </div>
  );
}

/** One job's interview prep (from the Job screen's Interview tab), or a way to start it. */
function JobPrep({ jobKey, entries, onOpen }: { jobKey: string; entries: LearnEntry[]; onOpen: (e: LearnEntry) => void }) {
  const [slug = "", id = ""] = jobKey.split("/");
  const mine = entries.filter((e) => e.source && e.source.company_slug === slug && e.source.id === id);
  const fromEntries = mine[0]?.source;
  // Only when this job has no prep yet do we need to ask for its title.
  const detail = useLoad((b) => (fromEntries ? Promise.resolve(null) : b.jobs.get(slug, id).then(
    (d) => ({ title: d.job.title, company_name: d.company?.name ?? "" }),
    () => null,
  )), [jobKey, !!fromEntries], ["jobs"]);
  const showAll = <Button variant="ghost" onClick={() => navigate({ screen: "learn" })}>All topics</Button>;
  const job = fromEntries ?? detail.data;
  if (!job) {
    if (detail.loading) return <Loading />;
    return <NextStep icon={Icons.guide} title={`That job isn't in your ${PRODUCT_NAME} folder any more`} body="It may have been archived or deleted. Your other topics are still here." action={showAll} />;
  }
  const name = `${displayName(job.title)}${job.company_name ? ` at ${displayName(job.company_name)}` : ""}`;
  return (
    <section className="learn-section" aria-labelledby="job-prep-title">
      <div className="learn-section__head learn-section__head--row">
        <SectionTitle icon={Icons.interview} title={<>Interview prep for {name}</>} id="job-prep-title" />
        <div className="row">
          <MakeVideoButton target={{ kind: "job", company_slug: slug, id }} label="Make video" ariaLabel={`Make video: ${name}`} />
          {showAll}
        </div>
      </div>
      {mine.length ? (
        <div className="learn-grid">{mine.map((e) => <LearnCard key={e.path} entry={e} onOpen={onOpen} />)}</div>
      ) : (
        <NextStep icon={Icons.guide} title={`No interview prep for ${name} yet`}
          body="Claude writes practice questions and answers for this job. They show up here as soon as they're saved."
          action={<RunButton action="interview_prep" target={{ kind: "job", company_slug: slug, id }} label="Interview prep" variant="primary" size="md" />} />
      )}
    </section>
  );
}

export function LearnScreen({ route }: { route: Route }) {
  const bridge = useBridge();
  const topicSlug = route.screen === "learn" ? route.topic : undefined;
  const startParam = route.screen === "learn" && route.start === true;
  const jobKey = route.screen === "learn" ? route.job : undefined;
  const { data, error, reload } = useLoad((b) => b.learn.hub(), [], ["learn", "jobs", "settings"]);
  // The videos CareerOS made (video.json records), with open, render again and delete. The hub leaves their files out.
  const videos = useLoad((b) => b.learn.list(), [], ["learn", "jobs", "video"]);
  const { busy, run } = useAction();
  const del = useDelete();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; initial: string }>({ open: startParam, initial: "" });
  const [started, setStarted] = useState<Extract<ActionTarget, { kind: "topic" }>[]>([]);
  useEffect(() => setOpenPath(null), [topicSlug]);
  useEffect(() => { if (startParam) setDialog({ open: true, initial: "" }); }, [startParam]);

  const startTopic = (initial = "") => setDialog({ open: true, initial });
  const closeDialog = () => { setDialog((d) => ({ ...d, open: false })); if (startParam) navigate({ screen: "learn" }); };

  if (error && !data) return <ErrorState title="Learn can't be shown" text={errorSentence(error)} />;
  if (!data) return <Loading />;

  const setProgress = (e: LearnEntry, p: LearnEntry["progress"]) =>
    run(`progress:${e.path}`, () => bridge.learn.setProgress(e.path, p).then(() => reload()));
  const open = (e: LearnEntry) => {
    setOpenPath(e.path);
    if (e.progress === "not_started") void setProgress(e, "in_progress");
  };
  const pickSuggestion = (s: SkillSuggestion) => {
    const guide = s.started ? data.entries.find((e) => e.topic === s.slug && e.type === "guide") : undefined;
    if (guide) open(guide); else startTopic(s.skill);
  };

  // A topic from the address bar (the Job screen's Gaps tab links here): its guide, or a way to start one.
  const topicEntry = topicSlug ? data.entries.find((e) => e.topic === topicSlug && e.type === "guide") ?? data.entries.find((e) => e.topic === topicSlug) : undefined;
  const reading = data.entries.find((e) => e.path === openPath) ?? (openPath === null ? topicEntry : undefined);
  const missingLabel = topicSlug && !topicEntry ? topicLabel(topicSlug.replace(/-/g, " ")) : "";
  const empty = data.entries.length === 0;
  // A topic's name: its guide's title ("RAG pipelines"), else the folder name in words.
  const topicName = (slug: string) => displayName(data.entries.find((e) => e.topic === slug && e.type === "guide")?.title ?? topicLabel(slug.replace(/-/g, " ")));

  // The topic list also offers this week's recap video, beside New topic rather than on a row of its own.
  const headWith = (recap: boolean) => (
    <><BackLink route={route} /><ScreenHead title="Learn" sub="Study guides and interview prep that Claude writes for the jobs you want."
      right={<>
        {recap ? <MakeVideoButton target={WORKSPACE} typeId="weekly-recap" label="Weekly recap" title="Make this week's recap video" /> : null}
        <Button variant="primary" icon={Icons.add} data-tour="learn-start" onClick={() => startTopic()}>New topic</Button>
      </>} settings="learn" /></>
  );
  const head = headWith(false);
  const dialogEl = <StartTopicDialog open={dialog.open} initial={dialog.initial} onClose={closeDialog} suggestions={data.suggestions}
    onStarted={(t) => setStarted((xs) => [...xs.filter((x) => x.topic !== t.topic), t])} />;
  const banner = (
    <>
      {error ? <ErrorState title="Learn can't be refreshed" text={errorSentence(error)} /> : null}
      <ClaudeNotice />
      <StudyRuns started={started} />
    </>
  );

  if (reading) {
    return (
      <>
        {head}{banner}{del.element}
        <Card className="reader-card">
          <Reader entry={reading} busy={busy === `progress:${reading.path}`}
            actions={reading.topic ? (
              <>
                <TopicVideoActions topic={reading.topic} name={topicName(reading.topic)} videos={videos.data?.videos} />
                {/* Only a topic of the person's own (learning/<topic>/), not a job's interview prep. */}
                {reading.path.startsWith(`learning/${reading.topic}/`) ? (
                  <MoreMenu label="More topic actions" items={[{ id: "delete", label: "Delete topic", tone: "danger",
                    onSelect: () => del.ask([{ kind: "topic", topic: reading.topic! }], {
                      label: "Delete topic", onDeleted: () => { setOpenPath(null); navigate({ screen: "learn" }); }, onRestored: () => navigate({ screen: "learn", topic: reading.topic! }),
                    }) }]} />
                ) : null}
              </>
            ) : undefined}
            onBack={() => { setOpenPath(null); if (topicSlug) navigate({ screen: "learn" }); }}
            onProgress={(done) => void setProgress(reading, done ? "done" : "in_progress")} />
        </Card>
        {reading.topic && videos.data ? (
          <div className="stack learn-videos">
            <VideoRegions videos={videos.data.videos} recaps={videos.data.video_recaps} topic={reading.topic} />
          </div>
        ) : null}
        {dialogEl}
      </>
    );
  }

  if (jobKey) {
    return (
      <>
        {head}{banner}
        <JobPrep jobKey={jobKey} entries={data.entries} onOpen={open} />
        {dialogEl}
      </>
    );
  }

  const gapCount = new Set(data.scored.flatMap((j) => j.gaps)).size;
  return (
    <>
      {headWith(true)}{banner}
      {missingLabel ? (
        <NextStep icon={Icons.guide} className="learn-missing" title={`No study guide for ${missingLabel} yet`}
          body="Ask Claude to write one. It shows up here as soon as it's saved."
          action={<Button variant="primary" onClick={() => startTopic(missingLabel)}>Start topic</Button>}
          secondary={<>
            <MakeVideoButton target={{ kind: "topic", topic: topicSlug!, label: missingLabel }} label="Make video" ariaLabel={`Make video: ${missingLabel}`} />
            <Button variant="ghost" onClick={() => navigate({ screen: "learn" })}>All topics</Button>
          </>} />
      ) : null}
      {missingLabel && videos.data ? <VideoRegions videos={videos.data.videos} recaps={videos.data.video_recaps} topic={topicSlug} /> : null}
      {data.suggestions.length ? <SuggestedTopics suggestions={data.suggestions} onPick={pickSuggestion} /> : null}
      {empty ? (
        <div className="learn-empty">
          {gapCount ? (
            <NextStep icon={Icons.learn} title={`You have ${gapCount} ${gapCount === 1 ? "gap" : "gaps"} from scored jobs`}
              body="Scoring found skills these jobs ask for that your profile doesn't show yet. Study one and Claude writes a guide for it."
              action={<Button variant="primary" icon={Icons.learn} onClick={() => startTopic(data.scored[0]!.gaps[0]!)}>Study them</Button>}
              secondary={<Button variant="ghost" icon={Icons.add} onClick={() => startTopic()}>New topic</Button>} />
          ) : (
            <NextStep icon={Icons.learn} title="Nothing to study yet"
              body={data.jobs
                ? "Start a topic yourself, or pick one of the suggestions above. Claude writes a study guide and it appears here."
                : "Start a topic yourself. Once you save some jobs, Learn also suggests the skills they ask for."}
              action={<Button variant="primary" icon={Icons.add} onClick={() => startTopic()}>New topic</Button>} />
          )}
          <NextTopics suggestions={data.suggestions} onGuide={startTopic} />
          <JobsToLearn hub={data} onGap={startTopic} />
          <GettingStarted always compact onStartTopic={() => startTopic()} />
        </div>
      ) : (
        <div className="learn-layout">
          <Library hub={data} onOpen={open} onGuide={startTopic} />
          <aside className="learn-side" aria-label="From your jobs and history">
            <JobsToLearn hub={data} onGap={startTopic} />
            <History entries={data.entries} onOpen={open} />
          </aside>
        </div>
      )}
      {!topicSlug && videos.data && (videos.data.videos.length || videos.data.video_recaps.length) ? (
        <section className="learn-section" aria-labelledby="learn-videos-title">
          <div className="learn-section__head"><Text role="heading-2" id="learn-videos-title">Your videos</Text></div>
          <VideoRegions videos={videos.data.videos} recaps={videos.data.video_recaps} />
        </section>
      ) : null}
      {dialogEl}
    </>
  );
}
