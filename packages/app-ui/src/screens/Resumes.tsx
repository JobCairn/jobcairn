import { useEffect, useId, useMemo, useState } from "react";
import { Button, Dialog, Icon, Icons, Input, Pill, Select, Table, Text, useToast, type Column } from "@careeros/brand";
import { isActiveRun, VARIANT_NAME, VARIANTS_DIR, type ClaudeRunView, type JobAdded, type ResumeItemRef, type ResumeLibrary, type ResumeRef } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { useClaudeRuns } from "../claude";
import { DateText } from "../components/DateText";
import { ErrorState, Loading, ScreenHead } from "../components/States";
import { AddJobDialog } from "../addjob/AddJobDialog";
import { CLAUDE_SETTINGS, navigate } from "../router";
import { plural } from "../format";
import { MoreMenu, type MoreItem } from "../mail/MoreMenu";
import { FoldHeading, GROUP_OVER, readView, saveView, TileGrid, type FilesView, type Tile } from "../resume/ResumeFiles";
import { useDelete } from "../trash";
import { useFileViewer } from "../viewer";
import "../composer/composer.css";
import "../resume/resumes.css";

type Tailored = ResumeLibrary["tailored"][number] & { writing: boolean };
type Variant = ResumeLibrary["variants"][number] & { writing: boolean };

/** Resumes Claude is writing right now: jobs (tailor_application) and general versions (tailor_resume_variant). */
function writing(runs: readonly ClaudeRunView[]): { jobs: Map<string, ClaudeRunView>; variants: Set<string> } {
  const jobs = new Map<string, ClaudeRunView>();
  const variants = new Set<string>();
  for (const r of runs) {
    if (!isActiveRun(r.status) || !r.target) continue;
    if (r.action === "tailor_application" && r.target.kind === "job") jobs.set(`${r.target.company_slug}/${r.target.id}`, r);
    if (r.action === "tailor_resume_variant" && r.target.kind === "resume_variant") variants.add(r.target.variant);
  }
  return { jobs, variants };
}

const editJob = (r: { company_slug: string; id: string }) => navigate({ screen: "resume", slug: r.company_slug, id: r.id, file: "resume.md" });
const jobRel = (r: { company_slug: string; id: string }) => `companies/${r.company_slug}/jobs/${r.id}/application/resume.md`;
const variantRel = (v: string) => `${VARIANTS_DIR}/${v}/resume.md`;
/** A general version's name made from another name: only the characters a name may have, at most 80. */
const copyName = (n: string) => `${n.replace(/[^\p{L}\p{N} +#./()&,'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 74)} copy`.trim();

type Target = { ref: ResumeItemRef; name: string; sent?: boolean };

/** Job statuses where the tailored resume has gone out: Applied and everything after it. */
const SENT_STATUSES: readonly string[] = ["Applied", "Interview", "Offer", "Rejected"];
const wasSent = (status: string) => SENT_STATUSES.includes(status);

/**
 * Every resume in one place, like a file browser: the person's own, the ones tailored to a job (in company folders
 * once there are many), and general versions for applying anywhere. Grid or list, remembered.
 */
export function ResumesScreen() {
  const bridge = useBridge();
  const toast = useToast();
  const lib = useLoad((b) => b.resumes.list(), [], ["jobs", "claude", "inbox", "settings"]);
  const runs = useClaudeRuns();
  const [creating, setCreating] = useState<"job" | "general" | null>(null);
  const [view, setView] = useState<FilesView>(readView);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [company, setCompany] = useState<string | null>(null);
  const [dup, setDup] = useState<Target | null>(null);
  const del = useDelete();
  const setDel = (t: Target) => del.ask([{ kind: "resume", ref: t.ref }], {
    label: t.ref.kind === "variant" ? "Delete version" : t.ref.kind === "base" ? "Delete file" : "Delete resume",
    note: t.sent ? "This is the copy you sent with your application." : t.ref.kind === "variant" ? "The whole version goes, with its versions and style." : undefined,
  });
  const live = useMemo(() => writing(runs.data ?? []), [runs.data]);
  const viewer = useFileViewer((lib.data?.base ?? []).map((b) => ({ rel: b.rel, title: b.name, at: b.at })));

  const tailored = useMemo<Tailored[]>(() => {
    const rows: Tailored[] = (lib.data?.tailored ?? []).map((t) => ({ ...t, writing: live.jobs.has(`${t.company_slug}/${t.id}`) }));
    for (const [k, r] of live.jobs) {
      if (rows.some((x) => `${x.company_slug}/${x.id}` === k) || r.target?.kind !== "job") continue;
      rows.unshift({ company_slug: r.target.company_slug, id: r.target.id, title: "", company_name: "", status: "", at: r.started_at, writing: true });
    }
    return rows;
  }, [lib.data, live]);
  const variants = useMemo<Variant[]>(() => (lib.data?.variants ?? []).map((v) => ({ ...v, writing: live.variants.has(v.variant) })), [lib.data, live]);

  const writeVariant = async (v: { variant: string; name: string }) => {
    try {
      await bridge.claude.run("tailor_resume_variant", { kind: "resume_variant", variant: v.variant, label: v.name }, {});
      runs.reload();
      toast({ tone: "success", text: `Claude is writing "${v.name}". It shows here when it's ready.` });
    } catch (e) { toast({ tone: "danger", text: errorText(e) }); }
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast({ tone: "success", text: ok }); } catch (e) { toast({ tone: "danger", text: errorText(e) }); }
  };
  const download = (ref: ResumeRef) => run(async () => {
    const r = await bridge.resume.download(ref, "resume.md", "pdf");
    toast(r.saved ? { tone: "success", text: "Saved the PDF" } : { tone: "neutral", text: "Nothing was saved." });
  });

  if (lib.error && !lib.data) return <ErrorState title="Resumes can't load" text={lib.error} />;
  if (!lib.data) return <Loading />;
  const { base } = lib.data;
  const fold = (id: string) => setFolded((f) => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickView = (v: FilesView) => { setView(v); saveView(v); };

  // ---- actions, shared by tiles and list rows ----
  const baseActions = (b: ResumeLibrary["base"][number]): MoreItem[] => [
    { id: "open", label: "Open", onSelect: () => viewer.open(b.rel, b.name) },
    { id: "edit", label: "Edit copy", onSelect: () => void run(async () => { const r = await bridge.resumes.duplicate({ kind: "base", rel: b.rel }, copyName(b.name.replace(/\.[^.]+$/, ""))); navigate({ screen: "resume-variant", variant: r.variant }); }) },
    { id: "dup", label: "Duplicate…", onSelect: () => setDup({ ref: { kind: "base", rel: b.rel }, name: b.name.replace(/\.[^.]+$/, "") }) },
    { id: "app", label: "Open externally", onSelect: () => void run(() => bridge.files.open(b.rel)) },
    { id: "reveal", label: "Show file", onSelect: () => void run(() => bridge.files.reveal(b.rel)) },
    { id: "delete", label: "Delete", tone: "danger", onSelect: () => setDel({ ref: { kind: "base", rel: b.rel }, name: b.name }) },
  ];
  const resumeActions = (ref: ResumeRef, name: string, rel: string, ready: boolean, edit: () => void, sent = false): MoreItem[] => (ready ? [
    { id: "open", label: "Open", onSelect: () => viewer.open(rel, name) },
    { id: "edit", label: "Edit", onSelect: edit },
    { id: "dup", label: "Duplicate…", onSelect: () => setDup({ ref, name }) },
    { id: "download", label: "Download PDF", onSelect: () => void download(ref) },
    { id: "reveal", label: "Show file", onSelect: () => void run(() => bridge.files.reveal(rel)) },
    { id: "delete", label: "Delete", tone: "danger", onSelect: () => setDel({ ref, name, sent }) },
  ] : [{ id: "delete", label: "Delete", tone: "danger", onSelect: () => setDel({ ref, name, sent }) }]);
  const tailoredName = (t: Tailored) => (t.title ? `${t.title}, ${t.company_name}` : "A job");
  const tActions = (t: Tailored) => (t.writing ? [] : resumeActions({ kind: "job", company_slug: t.company_slug, id: t.id }, tailoredName(t), jobRel(t), true, () => editJob(t), wasSent(t.status)));
  const vActions = (v: Variant) => (v.writing ? [] : [
    ...(!v.ready ? [{ id: "write", label: "Write version", onSelect: () => void writeVariant(v) }] : []),
    ...resumeActions({ kind: "variant", variant: v.variant }, v.name, variantRel(v.variant), v.ready, () => navigate({ screen: "resume-variant", variant: v.variant })),
  ]);

  // ---- tiles ----
  const baseTiles: Tile[] = base.map((b) => ({
    key: b.rel, name: b.name, fileName: b.name, at: b.at, source: /\.(md|markdown)$/i.test(b.name) ? { kind: "base", rel: b.rel } : null,
    meta: <>Added <DateText value={b.at} /></>, open: () => viewer.open(b.rel, b.name), openLabel: `Open ${b.name}`, actions: baseActions(b),
  }));
  const tailoredTile = (t: Tailored): Tile => ({
    key: `${t.company_slug}/${t.id}`, name: t.title ? `${t.title}, ${t.company_name}` : "A job", at: t.at,
    source: t.writing ? null : { kind: "job", company_slug: t.company_slug, id: t.id }, fileName: "resume.md", badge: t.writing ? "Being written" : undefined,
    meta: t.writing ? "Claude is writing it" : <>{t.status ? `${t.status} · ` : ""}<DateText value={t.at} empty="Not yet" /></>,
    open: () => { if (!t.writing) editJob(t); }, openLabel: t.writing ? `Resume for ${t.title || "a job"}, being written` : `Edit the resume for ${t.title}`, actions: tActions(t),
  });
  const grouped = tailored.length > GROUP_OVER;
  const companies = [...new Map(tailored.map((t) => [t.company_slug, t.company_name || t.company_slug])).entries()];
  const inCompany = company ? tailored.filter((t) => t.company_slug === company) : [];
  // Past GROUP_OVER, companies with two or more resumes become folders (shown first); a company's only resume stays a tile.
  const tailoredTiles: Tile[] = company ? inCompany.map(tailoredTile) : !grouped ? tailored.map(tailoredTile) : [
    ...companies.filter(([slug]) => tailored.filter((t) => t.company_slug === slug).length > 1).map(([slug, name]): Tile => {
      const rs = tailored.filter((t) => t.company_slug === slug);
      return {
        key: `folder:${slug}`, name, folder: rs.length, source: null, at: rs[0]?.at ?? "",
        meta: <>{plural(rs.length, "resume")} · <DateText value={rs[0]?.at} empty="Not yet" /></>,
        open: () => setCompany(slug), openLabel: `Open the ${name} folder, ${plural(rs.length, "resume")}`, actions: [],
      };
    }),
    ...tailored.filter((t) => tailored.filter((x) => x.company_slug === t.company_slug).length === 1).map(tailoredTile),
  ];
  const variantTiles: Tile[] = variants.map((v) => ({
    key: v.variant, name: v.name, at: v.at, source: v.ready && !v.writing ? { kind: "variant", variant: v.variant } : null, fileName: "resume.md",
    badge: v.writing ? "Being written" : !v.ready ? "Not written yet" : undefined,
    meta: v.writing ? "Claude is writing it" : <>{v.ready ? "Changed" : "Added"} <DateText value={v.at} empty="Not yet" /></>,
    open: () => { if (v.ready && !v.writing) navigate({ screen: "resume-variant", variant: v.variant }); else if (!v.writing) void writeVariant(v); },
    openLabel: v.ready ? `Edit ${v.name}` : v.writing ? `${v.name}, being written` : `Write ${v.name} with Claude`, actions: vActions(v),
  }));

  const more = (items: MoreItem[], name: string) => (items.length ? <MoreMenu label={`Actions for ${name}`} items={items} /> : null);
  const BASE_COLS: Column<ResumeLibrary["base"][number]>[] = [
    { key: "name", header: "File", alwaysOn: true, wrap: true, text: (r) => r.name, render: (r) => <Text role="body" as="div">{r.name}</Text> },
    { key: "at", header: "Added", width: "9rem", sortValue: (r) => r.at, firstSort: "desc", render: (r) => <DateText value={r.at} /> },
    { key: "more", header: "", width: "4rem", align: "end", sortable: false, inDetail: false, render: (r) => more(baseActions(r), r.name) },
  ];
  const TAILORED_COLS: Column<Tailored>[] = [
    { key: "role", header: "Job", alwaysOn: true, wrap: true, text: (r) => r.title ? `${r.title}, ${r.company_name}` : "A job",
      render: (r) => r.title
        ? <div><Text role="body" as="div">{r.title}</Text><Text role="body-sm" muted as="div">{r.company_name}</Text></div>
        : <Text role="body-sm" muted>Loading the job…</Text> },
    { key: "status", header: "Job status", width: "8rem", priority: "low", text: (r) => r.status, render: (r) => <Text role="body-sm">{r.status}</Text> },
    { key: "at", header: "Last changed", width: "9rem", sortValue: (r) => r.at, firstSort: "desc", render: (r) => <DateText value={r.at} empty="Not yet" /> },
    { key: "open", header: "", width: "11rem", align: "end", sortable: false, inDetail: false,
      render: (r) => r.writing ? <Pill tone="neutral">Being written</Pill> : <div className="row rf-rowactions"><Button size="sm" icon={Icons.file} onClick={() => editJob(r)} aria-label={`Edit the resume for ${r.title}`}>Edit</Button>{more(tActions(r), tailoredName(r))}</div> },
  ];
  const VARIANT_COLS: Column<Variant>[] = [
    { key: "name", header: "Version", alwaysOn: true, wrap: true, text: (r) => r.name,
      render: (r) => <div><Text role="body" as="div">{r.name}</Text>{r.ready || r.writing ? null : <Text role="body-sm" muted as="div">Not written yet</Text>}</div> },
    { key: "at", header: "Last changed", width: "9rem", sortValue: (r) => r.at, firstSort: "desc", render: (r) => <DateText value={r.at} empty="Not yet" /> },
    { key: "open", header: "", width: "11rem", align: "end", sortable: false, inDetail: false,
      render: (r) => r.writing ? <Pill tone="neutral">Being written</Pill>
        : <div className="row rf-rowactions">{r.ready ? <Button size="sm" icon={Icons.file} onClick={() => navigate({ screen: "resume-variant", variant: r.variant })} aria-label={`Edit ${r.name}`}>Edit</Button>
          : <Button size="sm" icon={Icons.ai} onClick={() => void writeVariant(r)} title="Claude hasn't written this version yet" aria-label={`Write ${r.name}`}>Write it</Button>}{more(vActions(r), r.name)}</div> },
  ];

  const baseEmpty = (
    <div className="resumes-empty">
      <Text role="body-sm" muted>Add your resume in Settings › Profile with Fill from my resume. Claude reads it, with your work history, for every version.</Text>
      <div><Button size="sm" onClick={() => navigate({ screen: "settings", tab: "profile" })}>Open Profile</Button></div>
    </div>
  );
  const tailoredEmpty = (
    <div className="resumes-empty">
      <Text role="body-sm" muted>None yet. Pick a job, or paste a job ad you found anywhere, and Claude writes a resume for it.</Text>
      <div><Button size="sm" icon={Icons.add} onClick={() => setCreating("job")}>Tailor resume</Button></div>
    </div>
  );
  const variantEmpty = (
    <div className="resumes-empty">
      <Text role="body-sm" muted>None yet. A general version has a focus, like Backend-heavy or For consulting firms, instead of one job ad.</Text>
      <div><Button size="sm" icon={Icons.add} onClick={() => setCreating("general")}>New version</Button></div>
    </div>
  );
  const companyName = company ? companies.find(([s]) => s === company)?.[1] ?? company : "";

  return (
    <>
      <ScreenHead title="Resumes" sub="Your own resume, the ones tailored to each job, and general versions for applying anywhere."
        right={
          <div className="row rf-top">
            <div className="rf-view" role="radiogroup" aria-label="View" data-tour="resumes-view">
              {(["grid", "list"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} tabIndex={view === v ? 0 : -1} className="rf-view__btn" onClick={() => pickView(v)}
                  onKeyDown={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                    e.preventDefault();
                    const other: FilesView = v === "grid" ? "list" : "grid";
                    pickView(other);
                    (e.currentTarget.parentElement?.querySelector(`[data-view="${other}"]`) as HTMLElement | null)?.focus();
                  }} data-view={v}>
                  <Icon icon={v === "grid" ? Icons.gridView : Icons.listView} size="sm" /><span>{v === "grid" ? "Grid" : "List"}</span>
                </button>
              ))}
            </div>
            <Button variant="primary" icon={Icons.add} data-tour="resumes-new" onClick={() => setCreating("job")}>Tailor resume</Button>
          </div>
        } />

      <section className="stack resumes-section" aria-labelledby="resumes-base" data-tour="resumes-base">
        <FoldHeading id="resumes-base" icon={Icons.user} title="Your resume" count={base.length} open={!folded.has("base")} onToggle={() => fold("base")} />
        {folded.has("base") ? null : view === "grid" ? <TileGrid tiles={baseTiles} label="Your resume" empty={baseEmpty} />
          : base.length ? <Table caption="Your resume" columns={BASE_COLS} rows={base} rowKey={(r) => r.rel} itemLabel="file" onRowActivate={(r) => viewer.open(r.rel, r.name)} /> : baseEmpty}
      </section>

      <section className="stack resumes-section" aria-labelledby="resumes-tailored" data-tour="resumes-tailored">
        <FoldHeading id="resumes-tailored" icon={Icons.jobs} title="Tailored to a job" count={tailored.length} open={!folded.has("tailored")} onToggle={() => fold("tailored")} />
        {folded.has("tailored") ? null : view === "grid" ? (
          <>
            {company ? (
              <nav className="rf-crumbs" aria-label="Folder">
                <button type="button" className="rf-crumbs__back" onClick={() => setCompany(null)}><Icon icon={Icons.back} size="sm" />All companies</button>
                <span aria-hidden="true">/</span><span aria-current="page">{companyName}</span>
              </nav>
            ) : null}
            <TileGrid tiles={tailoredTiles} label={company ? `Tailored resumes for ${companyName}` : "Tailored to a job"} empty={tailoredEmpty} />
          </>
        ) : tailored.length ? (
          <Table caption="Tailored to a job" columns={TAILORED_COLS} rows={tailored} rowKey={(r) => `${r.company_slug}/${r.id}`} itemLabel="resume"
            onRowActivate={(r) => { if (!r.writing) editJob(r); }} />
        ) : tailoredEmpty}
      </section>

      <section className="stack resumes-section" aria-labelledby="resumes-general" data-tour="resumes-general">
        <FoldHeading id="resumes-general" icon={Icons.file} title="General versions" count={variants.length} open={!folded.has("general")} onToggle={() => fold("general")}
          right={variants.length ? <Button size="sm" variant="ghost" icon={Icons.add} onClick={() => setCreating("general")}>New version</Button> : undefined} />
        {folded.has("general") ? null : view === "grid" ? <TileGrid tiles={variantTiles} label="General versions" empty={variantEmpty} />
          : variants.length ? <Table caption="General versions" columns={VARIANT_COLS} rows={variants} rowKey={(r) => r.variant} itemLabel="version"
            onRowActivate={(r) => { if (r.ready && !r.writing) navigate({ screen: "resume-variant", variant: r.variant }); }} /> : variantEmpty}
      </section>

      <NewResumeDialog open={creating !== null} initialKind={creating ?? "job"} onClose={() => setCreating(null)} tailored={lib.data.tailored} onStarted={() => { runs.reload(); lib.reload(); }} />
      <DuplicateDialog target={dup} onClose={() => setDup(null)} onDone={(variant, name) => { setDup(null); lib.reload(); toast({ tone: "success", text: `Copied as the general version "${name}".`, action: { label: "Edit it", onClick: () => navigate({ screen: "resume-variant", variant }) } }); }} />
      {del.element}
      {viewer.element}
    </>
  );
}

/** Duplicate as general version: the new version's name, then a copy of the resume (and its style). */
function DuplicateDialog({ target, onClose, onDone }: { target: Target | null; onClose(): void; onDone(variant: string, name: string): void }) {
  const bridge = useBridge();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (target) { setName(copyName(target.name)); setError(""); } }, [target]);
  const problem = variantNameProblem(name);
  const go = async () => {
    if (!target || problem) return;
    setBusy(true); setError("");
    try { const r = await bridge.resumes.duplicate(target.ref, name.replace(/\s+/g, " ").trim()); onDone(r.variant, name.trim()); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={target !== null} onClose={onClose} title="Duplicate as a general version"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!!problem} title={problem || undefined} onClick={() => void go()}>Duplicate</Button></>}>
      <div className="stack">
        <Text role="body-sm" muted>A copy you can edit on its own. The original stays as it is.</Text>
        <Input label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} error={problem || undefined} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        {error ? <Text role="body" className="rs-warn" as="p">{error}</Text> : null}
      </div>
    </Dialog>
  );
}

/** The general-version name rule, as a sentence (the same characters the prompt allows). */
export function variantNameProblem(name: string): string {
  const t = name.replace(/\s+/g, " ").trim();
  if (!t) return "Give it a focus, like Backend-heavy.";
  if (t.length > 80) return "Keep it to 80 characters.";
  if (!VARIANT_NAME.test(t)) return "Use letters, numbers, spaces and simple marks only (no quotes or symbols like < > \" ; : !).";
  return "";
}

/** "New tailored resume": for a job ad (a job you have, or a new ad you paste), or a general version with a focus. */
function NewResumeDialog({ open, onClose, tailored, onStarted, initialKind = "job" }: { open: boolean; onClose: () => void; tailored: ResumeLibrary["tailored"]; onStarted: () => void; initialKind?: "job" | "general" }) {
  const bridge = useBridge();
  const toast = useToast();
  const [kind, setKind] = useState<"job" | "general">(initialKind);
  useEffect(() => { if (open) setKind(initialKind); }, [open, initialKind]);
  const [job, setJob] = useState("");
  const [focus, setFocus] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const name = useId();
  const jobs = useLoad((b) => (open ? b.jobs.list({ limit: 500, showIneligible: true, sort: "newest" }) : Promise.resolve(null)), [open], ["jobs"]);
  const has = tailored.some((t) => `${t.company_slug}/${t.id}` === job);
  const problem = variantNameProblem(focus);

  const close = () => { setError(""); setTouched(false); onClose(); };
  const tailor = async (slug: string, id: string, title: string) => {
    setBusy(true); setError("");
    try {
      // Only the resume: an outside job may not want a cover letter (it can be added later on the job's Apply page).
      await bridge.claude.run("tailor_application", { kind: "job", company_slug: slug, id }, { options: { cover_letter: false } });
      onStarted(); close();
      toast({ tone: "success", text: `Claude is writing a resume for ${title}. It shows here when it's ready.` });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const general = async () => {
    setTouched(true);
    if (problem) return;
    setBusy(true); setError("");
    const label = focus.replace(/\s+/g, " ").trim();
    try {
      const { variant } = await bridge.resumes.newVariant(label);
      onStarted();
      await bridge.claude.run("tailor_resume_variant", { kind: "resume_variant", variant, label }, {});
      onStarted(); close();
      toast({ tone: "success", text: `Claude is writing "${label}". It shows here when it's ready.` });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const chosen = jobs.data?.rows.find((r) => `${r.company_slug}/${r.id}` === job);
  const added = (j: JobAdded) => { setAdding(false); setJob(`${j.company_slug}/${j.id}`); jobs.reload(); void tailor(j.company_slug, j.id, j.title); };
  const claudeProblem = /claude/i.test(error) && /set ?up|sign in|install|consent|turn on/i.test(error);

  return (
    <>
      <Dialog open={open && !adding} onClose={close} title="New tailored resume"
        actions={<>
          <Button onClick={close}>Cancel</Button>
          {kind === "job" ? (has
            ? <Button variant="primary" onClick={() => { const [s, i] = job.split("/"); close(); navigate({ screen: "resume", slug: s!, id: i!, file: "resume.md" }); }}>Open resume</Button>
            : <Button variant="primary" icon={Icons.ai} loading={busy} disabled={!chosen} title={chosen ? undefined : "Choose a job first, or paste a new ad"} onClick={() => chosen && void tailor(chosen.company_slug, chosen.id, chosen.title)}>Write resume</Button>)
            : <Button variant="primary" icon={Icons.ai} loading={busy} onClick={() => void general()}>Write version</Button>}
        </>}>
        <div className="stack newresume">
          <div className="newresume__kinds" role="radiogroup" aria-label="What it's for">
            {([["job", "For a job ad", "Tailored to one ad: a job in your list, or one you paste now."], ["general", "General version", "No ad. A focus, like Backend-heavy or For consulting firms."]] as const).map(([k, label, hint]) => (
              <label key={k} className="newresume__kind">
                <input type="radio" name={name} value={k} checked={kind === k} onChange={() => { setKind(k); setError(""); }} />
                <span className="newresume__kind-label">{label}</span>
                <span className="newresume__kind-hint t-body-sm">{hint}</span>
              </label>
            ))}
          </div>

          {kind === "job" ? (
            <div className="stack">
              <Select label="Job" value={job} onChange={(e) => setJob(e.target.value)}
                options={[{ value: "", label: jobs.data ? "Choose a job" : "Loading your jobs…" }, ...(jobs.data?.rows ?? []).map((r) => ({ value: `${r.company_slug}/${r.id}`, label: `${r.title} · ${r.company_name}` }))]} />
              {has ? <Text role="body-sm" muted>This job already has a tailored resume. Open it to edit, or ask Claude for a rewrite there.</Text> : null}
              <div className="newresume__or">
                <Text role="body-sm" muted as="span">Found it somewhere else?</Text>
                <Button size="sm" icon={Icons.add} onClick={() => setAdding(true)}>Paste ad</Button>
              </div>
              <Text role="body-sm" muted>Claude writes the resume from your own files, aimed at the ad. No cover letter unless you ask for one later.</Text>
            </div>
          ) : (
            <div className="stack">
              <Input label="Focus" value={focus} maxLength={80} placeholder="Backend-heavy" onChange={(e) => setFocus(e.target.value)} onBlur={() => setTouched(true)}
                error={touched && problem ? problem : undefined} help="What this version should lead with. Claude writes it from your own files only." />
              <div className="newresume__examples" aria-label="Examples">
                {["Backend-heavy", "For consulting firms", "AI and machine learning", "Short, one page"].map((x) => (
                  <button key={x} type="button" className="example-chip" onClick={() => { setFocus(x); setTouched(false); }}>{x}</button>
                ))}
              </div>
            </div>
          )}

          {error ? (
            <div className="addjob__problem" role="alert">
              <Text role="body">{error}</Text>
              {claudeProblem ? <div><Button size="sm" onClick={() => { close(); navigate(CLAUDE_SETTINGS); }}>Claude setup</Button></div> : null}
            </div>
          ) : null}
        </div>
      </Dialog>
      <AddJobDialog open={open && adding} onClose={() => setAdding(false)} onAdded={added} saveLabel="Save and write resume" title="Paste a job ad" />
    </>
  );
}
