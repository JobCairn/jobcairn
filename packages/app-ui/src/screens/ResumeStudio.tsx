import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, Card, Pill, Tabs, Text, useToast } from "@careeros/brand";
import {
  fitSteps, noteProblems, PAGE_WARNING_OVER, parseResume, pickFit, sectionKey, serializeResume, SUGGESTED_FOR, type ActionTarget, type FitResult, type ResumeModel, type ResumeRef,
  type ResumeState, type ResumeStyle, type RewriteOptions, type SuggestionDecision,
} from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { ErrorState, Loading } from "../components/States";
import { BackLink } from "../nav";
import { fmtTime, plural } from "../format";
import { ClaudeRunPanel, useClaudeRun } from "../claude";
import { Editor } from "../resume/Editor";
import { record, redo, reset, startHistory, undo, type History } from "../resume/history";
import { DownloadPanel, StylePanel, SuggestionPanel, VersionsPanel } from "../resume/Panels";
import { Preview } from "../resume/Preview";
import { navigate, type Route } from "../router";
import "../resume/resume.css";

/** Autosave waits this long after the last change. */
export const AUTOSAVE_MS = 1500;

type Doc = { model: ResumeModel; style: ResumeStyle };
type Tab = "content" | "style" | "ai" | "versions" | "download";
type SaveState = { kind: "saved"; at: string } | { kind: "saving" } | { kind: "unsaved" } | { kind: "error"; text: string };

const sameStyle = (a: ResumeStyle, b: ResumeStyle) => JSON.stringify(a) === JSON.stringify(b);
const docOf = (s: ResumeState): Doc => ({ model: parseResume(s.markdown), style: s.style });

/**
 * Fit to N pages: measures the current style and each tighter step off screen, one at a time, then keeps the first
 * that fits (contract pickFit). Nothing is shown while it runs.
 */
function FitRunner({ model, base, target, onDone }: { model: ResumeModel; base: ResumeStyle; target: number; onDone(r: FitResult, target: number): void }) {
  const cands = useMemo(() => [base, ...fitSteps(base)], [base]);
  const [i, setI] = useState(0);
  const measured = useRef<number[]>([]);
  const done = useRef(false);
  const onPages = useCallback((p: number) => {
    if (done.current) return;
    measured.current[i] = p;
    if (p <= target || i === cands.length - 1) { done.current = true; onDone(pickFit(base, target, measured.current), target); }
    else setI(i + 1);
  }, [i, cands.length, target, base, onDone]);
  return <div className="rs-measure"><Preview key={i} model={model} style={cands[i]!} measureOnly onPages={onPages} /></div>;
}

/** Studio handles a job's tailored resume (#/resume/<slug>/<id>/<file>) and a general version (#/resume-variant/<variant>). */
export function ResumeStudioScreen({ route }: { route: Route }) {
  if (route.screen === "resume") {
    return <Studio key={`${route.slug}/${route.id}/${route.file}`} rref={{ kind: "job", company_slug: route.slug, id: route.id }} file={route.file} route={route} />;
  }
  if (route.screen === "resume-variant") return <Studio key={`variant/${route.variant}`} rref={{ kind: "variant", variant: route.variant }} file="resume.md" route={route} />;
  return <Loading />;
}

function Studio({ rref: given, file, route }: { rref: ResumeRef; file: string; route: Route }) {
  const bridge = useBridge();
  // One object per resume, so loads and saves don't restart on every render.
  const rref = useMemo(() => given, [JSON.stringify(given)]); // eslint-disable-line react-hooks/exhaustive-deps
  const toast = useToast();
  const job = rref.kind === "job" ? rref : null;
  // Claude's rewrite runs through the engine (rewrite_resume). Only positions in the saved file go with it. Jobs only:
  // a general version is written again from the Resumes screen instead.
  const target = useMemo<ActionTarget>(() => (job ? { kind: "job", company_slug: job.company_slug, id: job.id } : { kind: "workspace" }), [job?.company_slug, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const claude = useClaudeRun("rewrite_resume", target);
  const canAsk = !!job && file === SUGGESTED_FOR;
  const [note, setNote] = useState("");
  const [server, setServer] = useState<ResumeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<History<Doc> | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: "" });
  const [conflict, setConflict] = useState<ResumeState | null>(null);
  const [tab, setTab] = useState<Tab>("content");
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  // Two-way linking: what's selected (field id, then its entry and section), and focus requests from a preview click.
  const [selected, setSelected] = useState<string[]>([]);
  const [focusReq, setFocusReq] = useState<{ id: string; tick: number } | null>(null);
  const [said, setSaid] = useState("");
  const [fit, setFit] = useState<{ target: number; base: ResumeStyle } | null>(null);
  const [fitNote, setFitNote] = useState<string | null>(null);

  const doc = hist?.present ?? null;
  const md = useMemo(() => (doc ? serializeResume(doc.model) : ""), [doc]);
  const dirty = !!(server && doc && (md !== server.markdown || !sameStyle(doc.style, server.style)));

  // Refs so timers, change events and the unmount flush always see the latest values.
  const live = useRef({ server, doc, md, dirty, conflict });
  live.current = { server, doc, md, dirty, conflict };
  const saving = useRef<Promise<boolean> | null>(null);
  /** Set by "Keep my edits": the next save keeps the outside version as a "replaced" version first. */
  const replacing = useRef(false);

  const load = useCallback(() => bridge.resume.load(rref, file), [bridge, rref, file]);
  useEffect(() => {
    let on = true;
    load().then((s) => { if (on) { setServer(s); setHist(startHistory(docOf(s))); setSave({ kind: "saved", at: s.saved_at }); } }, (e: unknown) => { if (on) setError(errorText(e)); });
    return () => { on = false; };
  }, [load]);

  /** Saves the latest edits. Resolves false when the save failed (the reason is shown). One save at a time. */
  const flush = useCallback(async (): Promise<boolean> => {
    while (saving.current) await saving.current;
    const { server: s, doc: d, md: text, dirty: changed, conflict: c } = live.current;
    if (!s || !d) return false;
    if (c) return false;
    if (!changed) return true;
    setSave({ kind: "saving" });
    const run = (async () => {
      try {
        const r = await bridge.resume.save(rref, file, text, d.style, s.digest, replacing.current);
        replacing.current = false;
        setServer(r);
        live.current.server = r;
        setSave({ kind: "saved", at: r.saved_at });
        return true;
      } catch (e) {
        const msg = errorText(e);
        if (/changed outside/.test(msg)) { try { setConflict(await load()); } catch { /* the banner below still explains */ } }
        setSave({ kind: "error", text: msg });
        return false;
      }
    })();
    saving.current = run;
    try { return await run; } finally { saving.current = null; }
  }, [bridge, rref, file, load]);

  // Autosave after a pause in typing; and a last save when the screen closes.
  useEffect(() => {
    if (!dirty || conflict) return undefined;
    setSave((s) => (s.kind === "saving" ? s : { kind: "unsaved" }));
    const t = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [md, doc?.style, dirty, conflict, flush]);
  useEffect(() => () => { if (live.current.dirty) void flush(); }, [flush]);

  // Claude (or another app) may change the files: the suggestion, versions, or the resume itself.
  useEffect(() => bridge.onChange((e) => {
    // "claude": a rewrite_resume run finished and may have written its suggestion.
    if (!e.areas.includes("jobs") && !e.areas.includes("claude")) return;
    load().then((r) => {
      const cur = live.current;
      if (!cur.server) return;
      if (r.digest === cur.server.digest || r.markdown === cur.md) { setServer(r); return; }
      if (!cur.dirty) { setServer(r); setHist(reset(docOf(r))); return; }
      setConflict(r);
    }, () => undefined);
  }), [bridge, load]);

  const change = useCallback((next: Doc, key?: string) => setHist((h) => (h ? record(h, next, key ?? null) : h)), []);
  const onModel = useCallback((m: ResumeModel, key?: string) => { if (live.current.doc) change({ ...live.current.doc, model: m }, key); }, [change]);
  const onStyle = useCallback((st: ResumeStyle) => { if (live.current.doc) change({ ...live.current.doc, style: st }); }, [change]);
  const toggleHidden = useCallback((heading: string) => {
    const d = live.current.doc;
    if (!d) return;
    const k = sectionKey(heading);
    onStyle({ ...d.style, hidden: d.style.hidden.includes(k) ? d.style.hidden.filter((h) => h !== k) : [...d.style.hidden, k] });
  }, [onStyle]);

  /** Runs a change on the services after saving the latest edits, then adopts the new file as an undoable step. */
  const act = async (fn: (digest: string) => Promise<ResumeState>, ok: string) => {
    setBusy(true);
    try {
      if (!(await flush())) return;
      const r = await fn(live.current.server!.digest);
      setServer(r);
      if (r.markdown !== live.current.md) setHist((h) => (h ? record(h, docOf({ ...r, style: live.current.doc!.style })) : h));
      toast({ tone: "success", text: ok });
    } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(false); }
  };

  const rewrite = async (options: RewriteOptions) => {
    if (noteProblems(note).length) { setTab("ai"); return; }
    setBusy(true);
    try {
      // Claude reads the saved file, so save first; the main process maps the positions against it.
      if (!(await flush())) return;
      setTab("ai");
      await claude.start({ options: { ...options }, note });
    } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(false); }
  };

  const pick = useCallback((id: string) => {
    setTab("content");
    setSelected([id]);
    setFocusReq((f) => ({ id, tick: (f?.tick ?? 0) + 1 }));
  }, []);
  const fitDone = useCallback((r: FitResult, target: number) => {
    setFit(null);
    if (r.changes.length) onStyle(r.style);
    const what = r.changes.length ? `Changed ${r.changes.join(", ")}.` : "";
    setFitNote(r.fits ? `${what} It now fits on ${plural(target, "page")}.`.trim() : `${what} It still needs ${plural(r.pages, "page")}. Hide a section or shorten older roles.`.trim());
  }, [onStyle]);

  const decide = async (d: SuggestionDecision) => {
    const ok: Record<SuggestionDecision, string> = { accept: "Accepted Claude's rewrite", keep: "Kept your edits. Claude's version is under Versions.", reject: "Suggestion rejected" };
    await act((digest) => bridge.resume.suggestion(rref, file, d, digest), ok[d]);
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); setHist((h) => (h ? undo(h) : h)); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); setHist((h) => (h ? redo(h) : h)); }
  };

  if (error && !server) {
    return <ErrorState title="This resume can't be opened" text={error} action={<div>{job
      ? <Button onClick={() => navigate({ screen: "apply", slug: job.company_slug, id: job.id })}>Open application</Button>
      : <Button onClick={() => navigate({ screen: "resumes" })}>All resumes</Button>}</div>} />;
  }
  if (!server || !hist || !doc) return <Loading />;

  const openCount = server.suggestion ? 1 : 0;
  const over = pages > PAGE_WARNING_OVER;
  const status = save.kind === "saving" ? "Saving…" : save.kind === "unsaved" ? "Unsaved changes" : save.kind === "error" ? "Not saved" : `Saved${save.at ? ` at ${fmtTime(save.at)}` : ""}`;

  return (
    <div className="rs-studio" onKeyDown={onKey}>
      <header className="screen-head rs-head">
        <div className="grow">
          <BackLink route={route} />
          <Text role="display">Edit resume</Text>
          <Text role="body" muted className="screen-head__sub">{job ? `${server.title} at ${server.company_name}` : `General version: ${server.title}`}</Text>
        </div>
        <div className="row rs-toolbar">
          <span data-tour="resume-save" className={`rs-save rs-save--${save.kind}`} role="status" aria-live="polite">{status}</span>
          <Button size="sm" variant="ghost" disabled={!hist.past.length} title={hist.past.length ? "Undo (Cmd or Ctrl + Z)" : "Nothing to undo yet"} onClick={() => setHist(undo(hist))}>Undo</Button>
          <Button size="sm" variant="ghost" disabled={!hist.future.length} title={hist.future.length ? "Redo (Shift + Cmd or Ctrl + Z)" : "Nothing to redo"} onClick={() => setHist(redo(hist))}>Redo</Button>
        </div>
      </header>

      {save.kind === "error" && !conflict ? <Card className="rs-banner" role="alert"><Text role="body">{save.text}</Text><div><Button size="sm" onClick={() => void flush()}>Try again</Button></div></Card> : null}
      {conflict ? (
        <Card className="rs-banner" role="alert">
          <Text role="body">This resume changed outside the studio, maybe because Claude wrote it. Your unsaved edits here aren't in that version. If you keep your edits, the other version is saved under Versions.</Text>
          <div className="row">
            <Button size="sm" variant="primary" onClick={() => { setServer(conflict); setHist(reset(docOf(conflict))); setConflict(null); setSave({ kind: "saved", at: conflict.saved_at }); }}>Load new</Button>
            <Button size="sm" variant="ghost" onClick={() => {
              // Write my edits over the new file; the services keep the new file as a "replaced" version first.
              replacing.current = true;
              setServer(conflict); live.current.server = conflict; setConflict(null); live.current.conflict = null; void flush();
            }} title="Keep my edits and replace the new version">Keep mine</Button>
          </div>
        </Card>
      ) : null}

      <div className="rs-split">
        <div className="rs-left">
          <Tabs label="Resume tools" value={tab} onChange={(t) => setTab(t as Tab)}
            tabs={[{ id: "content", label: "Content" }, { id: "style", label: "Style" }, ...(job ? [{ id: "ai", label: "AI suggestions", count: openCount }] : []), { id: "versions", label: "Versions", count: server.versions.length }, { id: "download", label: "Download" }]}>
            {tab === "content" ? <Editor model={doc.model} style={doc.style} onChange={onModel} onToggleHidden={toggleHidden} onRewrite={canAsk ? (s) => void rewrite(s) : undefined}
              busy={busy || claude.running} onSelect={setSelected} focus={focusReq} announce={setSaid} /> : null}
            {tab === "style" ? <StylePanel style={doc.style} model={doc.model} pages={pages} onChange={(st) => { setFitNote(null); onStyle(st); }}
              onFit={(target) => { setFitNote(null); setFit({ target, base: doc.style }); }} fitting={!!fit} fitNote={fitNote} /> : null}
            {tab === "ai" ? (
              <SuggestionPanel state={server} current={md} busy={busy || claude.running} canAsk={canAsk} note={note} onNote={setNote}
                onAskAll={() => void rewrite({ scope: "resume" })} onDecide={(d) => void decide(d)}
                run={<ClaudeRunPanel action="rewrite_resume" target={target} run={claude.run} onRetry={() => void claude.start().catch(() => undefined)} />} />
            ) : null}
            {tab === "versions" ? <VersionsPanel state={server} current={md} busy={busy} onRestore={(v) => void act((digest) => bridge.resume.restore(rref, file, v, digest), "Version restored")} /> : null}
            {tab === "download" ? <DownloadPanel state={server} flush={flush} /> : null}
          </Tabs>
        </div>
        <aside className="rs-right" aria-label="Preview" data-tour="resume-preview">
          <div className="row rs-pages">
            <Pill tone={over ? "warning" : "neutral"}>{plural(pages, "page")}</Pill>
            {over ? <Text role="body-sm" className="rs-warn">Longer than {PAGE_WARNING_OVER} pages. Most recruiters read one or two; hide a section or trim older roles.</Text> : <Text role="body-sm" muted>Live preview of the PDF layout.</Text>}
          </div>
          <Preview model={doc.model} style={doc.style} onPages={setPages} onPick={pick} selected={selected} />
          <Text role="body-sm" muted className="rs-pick-hint">Click any part of the page to edit it.</Text>
        </aside>
      </div>
      {fit ? <FitRunner model={doc.model} base={fit.base} target={fit.target} onDone={fitDone} /> : null}
      <div className="sr-only" role="status" aria-live="polite">{said}</div>
    </div>
  );
}
