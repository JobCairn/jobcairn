import { useEffect, useMemo, useState } from "react";
import { Button, Card, Icon, Icons, Pill, Text, useToast } from "@careeros/brand";
import {
  actionKey, isActiveRun, researchRequest, RESEARCH_STALE_DAYS, type ActionTarget, type ClaudeRunView, type ResearchTopic, type ResearchView,
} from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { ClaudeRunPanel, RunChip, useClaudeEngine, useClaudeRun, useClaudeRuns } from "../claude";
import { errorSentence } from "../components/ErrorBanner";
import { Markdown } from "../components/Markdown";
import { MakeVideoButton } from "../components/MakeVideo";
import { ErrorState, Loading, ScreenHead } from "../components/States";
import { MoreMenu } from "../mail/MoreMenu";
import { BackLink } from "../nav";
import { NextStep } from "../guide";
import { fmtDayOf } from "../reading/dates";
import { NewResearchDialog, RESEARCH_IDEAS } from "../research/NewResearchDialog";
import { ReportView } from "../research/ReportView";
import { navigate, type Route } from "../router";
import { useDelete } from "../trash";
import "../learn/learn.css";
import "../research/research.css";

type ResearchTarget = Extract<ActionTarget, { kind: "research" }>;
const targetOf = (t: Pick<ResearchTopic, "slug" | "title">): ResearchTarget => ({ kind: "research", topic: t.slug, label: t.title });
const DEPTH = { quick: "Quick", thorough: "Thorough" } as const;

/** The topic's state for its card: written (and when), stale, or not written yet. */
function TopicCard({ topic, run }: { topic: ResearchTopic; run: ClaudeRunView | undefined }) {
  const state = !topic.at ? "empty" : topic.stale ? "stale" : "ready";
  const open = () => navigate({ screen: "research", topic: topic.slug });
  return (
    <article className="research-card" data-state={state} aria-label={topic.title}>
      <span className="research-card__kicker t-label"><Icon icon={Icons.research} size="sm" />Research</span>
      <h3 className="research-card__title"><button type="button" className="research-card__open" onClick={open}>{topic.title}</button></h3>
      {topic.questions ? <p className="research-card__q">{topic.questions}</p> : null}
      <div className="research-card__foot">
        {run && isActiveRun(run.status) ? <Pill tone="accent">Researching</Pill>
          : state === "empty" ? <Pill tone="neutral">Not written yet</Pill>
          : <Pill tone={state === "stale" ? "warning" : "success"}>{`As of ${fmtDayOf(topic.as_of || topic.at)}`}</Pill>}
        {state === "stale" && !(run && isActiveRun(run.status)) ? <Pill tone="warning">Needs refresh</Pill> : null}
        <span className="t-body-sm t-muted">{DEPTH[topic.depth]}</span>
      </div>
    </article>
  );
}

function TopicList({ topics, onNew }: { topics: ResearchTopic[]; onNew: (idea?: string) => void }) {
  const runs = useClaudeRuns();
  const runFor = useMemo(() => {
    const m = new Map<string, ClaudeRunView>();
    for (const r of runs.data ?? []) if (r.action === "research_topic" && (!m.has(r.key) || isActiveRun(r.status))) m.set(r.key, r);
    return (t: ResearchTopic) => m.get(actionKey("research_topic", targetOf(t)));
  }, [runs.data]);
  if (!topics.length) {
    return (
      <NextStep icon={Icons.research} title="Nothing researched yet"
        body="Ask Claude about anything for your job search: a visa, a country's skilled migration rules, pay for a role in a city. It reads official sources first, cites every fact and dates the report."
        action={<Button variant="primary" icon={Icons.add} onClick={() => onNew()}>New research</Button>}
        secondary={<div className="research-ideas">{RESEARCH_IDEAS.slice(0, 3).map((i) => (
          <button key={i} type="button" className="topic-chip" onClick={() => onNew(i)}>{i}</button>
        ))}</div>} />
    );
  }
  return (
    <section className="learn-section" aria-label="Your research">
      <div className="research-grid">{topics.map((t) => <TopicCard key={t.slug} topic={t} run={runFor(t)} />)}</div>
    </section>
  );
}

/** Export HTML, Save PDF and where the files went. */
function Exports({ view }: { view: ResearchView }) {
  const bridge = useBridge();
  const toast = useToast();
  const { busy, run } = useAction();
  const slug = view.topic.slug;
  const can = !!view.report || view.markdown !== null;
  const html = () => run("html", () => bridge.research.exportHtml(slug).then((rel) => toast({
    tone: "success", text: "Saved report.html in the topic's folder.", action: { label: "Show file", onClick: () => void bridge.files.reveal(rel) },
  })));
  const pdf = () => run("pdf", () => bridge.research.exportPdf(slug).then((rel) => toast({
    tone: "success", text: "Saved report.pdf in the topic's folder.", action: { label: "Open PDF", onClick: () => void bridge.files.open(rel).catch((e: unknown) => toast({ tone: "danger", text: errorText(e) })) },
  })));
  if (!can) return null;
  return (
    <>
      <Button size="sm" variant="secondary" icon={Icons.exportFile} loading={busy === "html"} title="Save the report as one web page you can share" onClick={() => void html()}>Export HTML</Button>
      <Button size="sm" variant="secondary" icon={Icons.print} loading={busy === "pdf"} title="Save the report as a PDF" onClick={() => void pdf()}>Save PDF</Button>
    </>
  );
}

function TopicPage({ slug, route }: { slug: string; route: Route }) {
  const bridge = useBridge();
  const del = useDelete();
  const engine = useClaudeEngine();
  const view = useLoad((b) => b.research.get(slug), [slug], ["learn"]);
  const v = view.data;
  const target = useMemo<ResearchTarget>(() => ({ kind: "research", topic: slug, label: v?.topic.title ?? slug.replace(/-/g, " ") }), [slug, v?.topic.title]);
  const claude = useClaudeRun("research_topic", target);
  const [asked, setAsked] = useState(false);
  const running = claude.running;
  // When Claude finishes, read the report again.
  useEffect(() => { if (!running && claude.run?.status === "succeeded") view.reload(); }, [running, claude.run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.error && !v) {
    return (
      <>
        <BackLink route={route} />
        <ErrorState title="This research can't be shown" text={errorSentence(view.error)}
          action={<div><Button variant="ghost" icon={Icons.back} onClick={() => navigate({ screen: "research" })}>All research</Button></div>} />
      </>
    );
  }
  if (!v) return <Loading />;
  const t = v.topic;
  const start = async () => {
    setAsked(true);
    if (claude.ready) await claude.start(researchRequest(t)).catch(() => undefined);
  };
  const label = t.at ? "Refresh" : "Research";
  const chip = claude.run && (running || (asked && (claude.run.status === "failed" || claude.run.status === "cancelled")));

  return (
    <div className="research-page">
      <BackLink route={route} />
      <div className="research-bar">
        <Button size="sm" variant="ghost" icon={Icons.back} onClick={() => navigate({ screen: "research" })}>All research</Button>
        <div className="research-bar__actions">
          {chip ? <RunChip run={claude.run!} onCancel={() => void claude.cancel()} onRetry={() => void start()} />
            : <Button size="sm" variant={t.at ? "secondary" : "primary"} icon={t.at ? Icons.refresh : Icons.ai} aria-label={`${label}: ${t.title}`}
              title={t.at ? "Ask Claude to check the sources again and rewrite the report" : "Ask Claude to research this topic"} onClick={() => void start()}>{label}</Button>}
          {t.at ? <MakeVideoButton target={target} label="Make video" ariaLabel={`Make video: ${t.title}`} /> : null}
          <Exports view={v} />
          <MoreMenu label="More research actions" items={[{ id: "delete", label: "Delete research", tone: "danger",
            onSelect: () => del.ask([{ kind: "research", topic: slug }], {
              label: "Delete research", onDeleted: () => navigate({ screen: "research" }), onRestored: () => navigate({ screen: "research", topic: slug }),
            }) }]} />
        </div>
      </div>
      {del.element}
      {asked && engine.data && !engine.data.ready ? <ClaudeRunPanel action="research_topic" target={target} compact /> : null}
      {t.stale && !running ? (
        <p className="rr-callout rr-callout--warn research-stale" role="note">
          <Icon icon={Icons.watchOut} size="sm" />
          <span>{`This report is more than ${RESEARCH_STALE_DAYS} days old. Rules and numbers may have changed: refresh it before you rely on it.`}</span>
        </p>
      ) : null}
      {v.report ? (
        <Card className="research-report"><ReportView report={v.report} stale={t.stale} /></Card>
      ) : v.markdown !== null ? (
        <Card className="research-report">
          <div className="research-fallback" role="note">
            <Icon icon={Icons.info} size="sm" />
            <Text role="body-sm" as="p">This report is shown as plain text: its data file {v.problems.length ? "had problems" : "is missing"}. Refresh to ask Claude for it again.</Text>
          </div>
          <Markdown text={v.markdown} plain />
        </Card>
      ) : (
        <NextStep icon={Icons.research} title={running ? `Claude is researching ${t.title}` : `No report on ${t.title} yet`}
          body={running ? "It reads official sources first and checks each one. The report shows up here as soon as it's saved." : "Ask Claude to research it. The report shows up here as soon as it's saved."}
          action={running ? undefined : <Button variant="primary" icon={Icons.ai} onClick={() => void start()}>Research</Button>} />
      )}
      {v.exports.html || v.exports.pdf ? (
        <div className="research-exported t-body-sm t-muted">
          <span>Exported:</span>
          {v.exports.html ? <Button size="sm" variant="ghost" icon={Icons.showInFolder} aria-label="Show report.html in its folder" onClick={() => void bridge.files.reveal(v.exports.html!)}>report.html</Button> : null}
          {v.exports.pdf ? <Button size="sm" variant="ghost" icon={Icons.file} aria-label="Open report.pdf" onClick={() => void bridge.files.open(v.exports.pdf!)}>report.pdf</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ResearchScreen({ route }: { route: Route }) {
  const topic = route.screen === "research" ? route.topic : undefined;
  const startParam = route.screen === "research" && route.start === true;
  const list = useLoad((b) => b.research.list(), [], ["learn", "claude"]);
  const [dialog, setDialog] = useState(startParam);
  const [idea, setIdea] = useState<string | undefined>();
  useEffect(() => { if (startParam) setDialog(true); }, [startParam]);
  const openNew = (i?: string) => { setIdea(i); setDialog(true); };
  const close = () => { setDialog(false); if (startParam) navigate({ screen: "research" }); };
  const dialogEl = <NewResearchDialog open={dialog} initial={idea} onClose={close} onStarted={(t) => navigate({ screen: "research", topic: t.slug })} />;

  if (topic) return <><TopicPage slug={topic} route={route} />{dialogEl}</>;
  if (list.error && !list.data) return <ErrorState title="Research can't be shown" text={errorSentence(list.error)} />;
  return (
    <>
      <ScreenHead title="Research" sub="Ask Claude about anything for your search, like visas, pay or a job market. Each report cites its sources."
        right={<Button variant="primary" icon={Icons.add} onClick={() => openNew()}>New research</Button>} />
      {list.data ? <TopicList topics={list.data} onNew={openNew} /> : <Loading />}
      {dialogEl}
    </>
  );
}
