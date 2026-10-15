import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, Dialog, Pill, Select, Text, Textarea, useToast } from "@careeros/brand";
import {
  ACCENT_TEXT, BULLETS_TEXT, DATES_TEXT, DENSITY_TEXT, diffLines, FONT_TEXT, HEADINGS_TEXT, LAYOUT_TEXT, MARGINS_TEXT, NOTE_MAX, noteProblems, PAGE_TEXT,
  RESUME_ACCENT_IDS, RESUME_ACCENTS, RESUME_BULLETS, RESUME_DATES, RESUME_DENSITIES, RESUME_DOWNLOAD_TEXT, RESUME_DOWNLOADS, RESUME_FONTS, RESUME_HEADINGS,
  RESUME_MARGINS, RESUME_PAGES, RESUME_SIZES, sectionKey, SIZE_TEXT, TEMPLATE_INFO, VERSION_TEXT, type ResumeDownload, type ResumeModel, type ResumeState,
  type ResumeStyle, type SuggestionDecision,
} from "@careeros/contract";
import { Segmented } from "./controls";
import { TemplateGallery } from "./TemplateGallery";
import { errorText, useBridge } from "../bridge-context";
import { lineView } from "./line-view";
import { fmtDateTime, plural } from "../format";

// ---- Style -------------------------------------------------------------------------

export interface StyleProps {
  style: ResumeStyle; model: ResumeModel; pages: number; onChange(next: ResumeStyle): void;
  /** Fit to N pages: tries tighter spacing, then margins, then text size. */
  onFit(pages: number): void;
  fitting: boolean;
  /** What the last fit changed, in a sentence. */
  fitNote: string | null;
}

export function StylePanel({ style, model, pages, onChange, onFit, fitting, fitNote }: StyleProps) {
  const set = <K extends keyof ResumeStyle>(k: K, v: ResumeStyle[K]) => onChange({ ...style, [k]: v });
  const [target, setTarget] = useState(Math.max(1, Math.min(3, pages > 1 ? pages - 1 : 1)));
  const hidden = new Set(style.hidden);
  const toggle = (heading: string) => {
    const k = sectionKey(heading);
    onChange({ ...style, hidden: hidden.has(k) ? style.hidden.filter((h) => h !== k) : [...style.hidden, k] });
  };
  const mono = TEMPLATE_INFO[style.layout].mono;
  const opts = <T extends string>(list: readonly T[], text: Record<T, string>) => list.map((v) => ({ value: v, label: text[v] }));
  return (
    <div className="stack rs-style" aria-label="Style">
      <TemplateGallery style={style} model={model} onChange={onChange} />

      <fieldset className="rs-fieldset">
        <legend className="t-label">Fit to pages</legend>
        <div className="row rs-fit">
          <Select label="Pages" hideLabel value={String(target)} onChange={(e) => setTarget(Number(e.target.value))} options={[1, 2, 3].map((n) => ({ value: String(n), label: plural(n, "page") }))} />
          <Button loading={fitting} disabled={fitting || pages <= target} title={pages <= target ? `It already fits on ${plural(target, "page")}.` : undefined} onClick={() => onFit(target)}>Fit to {plural(target, "page")}</Button>
          <Text role="body-sm" muted as="span">Now {plural(pages, "page")}.</Text>
        </div>
        <Text role="body-sm" muted>Tries tighter spacing first, then narrower margins, then smaller text. It never removes words.</Text>
        {fitNote ? <Text role="body-sm" as="p" className="rs-fit__note" aria-live="polite">{fitNote}</Text> : null}
      </fieldset>

      <fieldset className="rs-fieldset">
        <legend className="t-label">Type and colour</legend>
        {mono ? <Text role="body-sm" muted>{`${LAYOUT_TEXT[style.layout]} is black and white, so the accent colour doesn't apply. Pick another template to use colour.`}</Text> : null}
        <Select label="Fonts" value={style.font} onChange={(e) => set("font", e.target.value as ResumeStyle["font"])} options={opts(RESUME_FONTS, FONT_TEXT)} help="Bundled open-licence fonts. Word files use Arial, Georgia and Source Serif 4." />
        <div className="field">
          <span className="field__label" id="rs-accent-label">Accent colour</span>
          <div className="rs-swatches" role="radiogroup" aria-labelledby="rs-accent-label">
            {RESUME_ACCENT_IDS.map((a) => (
              <button key={a} type="button" role="radio" className="rs-swatch" aria-checked={style.accent === a} aria-label={ACCENT_TEXT[a]} data-tip={mono ? `${ACCENT_TEXT[a]}: not used by ${LAYOUT_TEXT[style.layout]}` : ACCENT_TEXT[a]}
                aria-disabled={mono || undefined} disabled={mono} onClick={() => set("accent", a)}
                style={{ "--swatch": RESUME_ACCENTS[a] } as CSSProperties}>
                <span className="rs-swatch__dot" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        <Segmented label="Section headings" value={style.headings} options={opts(RESUME_HEADINGS, HEADINGS_TEXT)} onChange={(v) => set("headings", v)} />
      </fieldset>

      <fieldset className="rs-fieldset">
        <legend className="t-label">Layout</legend>
        <Segmented label="Spacing" value={style.density} options={opts(RESUME_DENSITIES, DENSITY_TEXT)} onChange={(v) => set("density", v)} />
        <Segmented label="Margins" value={style.margins} options={opts(RESUME_MARGINS, MARGINS_TEXT)} onChange={(v) => set("margins", v)} />
        <Segmented label="Text size" value={style.size} options={opts(RESUME_SIZES, SIZE_TEXT)} onChange={(v) => set("size", v)} />
        <Segmented label="Dates" value={style.dates} options={opts(RESUME_DATES, DATES_TEXT)} onChange={(v) => set("dates", v)} />
        <Segmented label="Bullets" value={style.bullets} options={opts(RESUME_BULLETS, BULLETS_TEXT)} onChange={(v) => set("bullets", v)} />
        <Segmented label="Page size" value={style.page} options={opts(RESUME_PAGES, PAGE_TEXT)} onChange={(v) => set("page", v)} />
      </fieldset>

      <fieldset className="rs-fieldset">
        <legend className="t-label">Sections in the resume</legend>
        {model.sections.length ? (
          <ul className="list-plain">
            {model.sections.map((s) => (
              <li key={s.id} className="checkbox">
                <input id={`show-${s.id}`} type="checkbox" checked={!hidden.has(sectionKey(s.heading))} onChange={() => toggle(s.heading)} />
                <label htmlFor={`show-${s.id}`}>{s.heading || "Untitled section"}</label>
              </li>
            ))}
          </ul>
        ) : <Text role="body-sm" muted>No sections yet.</Text>}
        <Text role="body-sm" muted>Hidden sections stay in the file but are left out of the preview and every download.</Text>
      </fieldset>
    </div>
  );
}

// ---- Claude's suggestion -----------------------------------------------------------

/**
 * A line diff that reads like the resume (headings, bullets, bold and italics, never raw markdown): removed lines
 * struck through, added lines marked. Text only, never HTML.
 */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const diff = diffLines(before, after);
  return (
    <div className="rs-linediff" role="group" aria-label="Differences">
      {diff.map((d, i) => {
        const v = lineView(d.text);
        if (v.kind === "blank") return <div key={i} className="rs-line rs-line--blank" aria-hidden="true" />;
        return (
          <div key={i} className={`rs-line rs-line--${d.op} rs-line--${v.kind}`}>
            <span className="rs-line__mark" aria-hidden="true">{d.op === "add" ? "+" : d.op === "del" ? "−" : ""}</span>
            {d.op === "add" ? <span className="sr-only">Added: </span> : d.op === "del" ? <span className="sr-only">Removed: </span> : null}
            <span className="rs-line__text">
              {v.runs.map((r, j) => (r.bold ? <strong key={j}>{r.text}</strong> : r.italic ? <em key={j}>{r.text}</em> : <span key={j}>{r.text}</span>))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface SuggestionProps {
  state: ResumeState;
  /** The editor's current text (saved before any decision). */
  current: string;
  busy: boolean;
  /** Only resume.md gets Claude's rewrites. */
  canAsk: boolean;
  note: string;
  onNote(note: string): void;
  onAskAll(): void;
  onDecide(decision: SuggestionDecision): void;
  /** H's live run panel for rewrite_resume. */
  run: ReactNode;
}

export function SuggestionPanel({ state, current, busy, canAsk, note, onNote, onAskAll, onDecide, run }: SuggestionProps) {
  const s = state.suggestion;
  const problems = noteProblems(note, []);
  const changed = s ? diffLines(current, s.markdown).filter((d) => d.op !== "same").length : 0;
  return (
    <div className="stack" aria-label="AI suggestions">
      {canAsk ? (
        <>
          <Text role="body-sm" muted>Claude rewrites your resume for this job's ad, using only facts from your history, past resumes and profile. Its version shows up here. Nothing changes until you accept it.</Text>
          <Textarea label="How you want it (optional)" rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => onNote(e.target.value)}
            help="Applies to the whole resume and to Rewrite on a section or bullet." />
          {problems.length ? <p className="t-body-sm rs-warn" role="alert">{problems[0]}</p> : null}
          <div className="row">
            <Button variant="primary" loading={busy} disabled={problems.length > 0} title={problems.length ? "Change the note first." : undefined} onClick={onAskAll}>Rewrite all</Button>
          </div>
          {run}
        </>
      ) : <Text role="body" muted>Claude's rewrites are for the tailored resume only.</Text>}
      {state.suggestion_problem ? <p className="t-body rs-warn" role="alert">{state.suggestion_problem}</p> : null}
      {s ? (
        <div className="stack rs-suggestion">
          <div className="row">
            <Text role="label" className="grow">Claude's suggested resume</Text>
            <Pill tone="accent">Suggestion</Pill>
          </div>
          <Text role="body-sm" muted>{`Written ${fmtDateTime(s.at)}. ${changed ? `${plural(changed, "line")} differ from your resume.` : "Same as your resume."} It isn't part of your application until you accept it.`}</Text>
          {s.older ? <Text role="body-sm" className="rs-warn">You saved changes after Claude wrote this. Accepting it replaces them; they stay under Versions.</Text> : null}
          <Text role="body-sm" muted>Check every fact before you accept it.</Text>
          <LineDiff before={current} after={s.markdown} />
          <div className="row">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide("accept")}>Accept</Button>
            <Button size="sm" variant="secondary" disabled={busy} title="Keep your resume as it is. Claude's version is saved under Versions." onClick={() => onDecide("keep")}>Keep mine</Button>
            <Button size="sm" variant="ghost" disabled={busy} title="Delete Claude's version" onClick={() => onDecide("reject")}>Reject</Button>
          </div>
        </div>
      ) : canAsk ? <Text role="body" muted>No suggestion yet. Use Rewrite with AI on a section or bullet, or rewrite the whole resume.</Text> : null}
    </div>
  );
}

// ---- Versions ----------------------------------------------------------------------

export function VersionsPanel({ state, current, busy, onRestore }: { state: ResumeState; current: string; busy: boolean; onRestore(id: string): void }) {
  const bridge = useBridge();
  const [open, setOpen] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const compare = async (id: string) => {
    setError(null);
    try { setOpen({ id, text: await bridge.resume.version(state.ref, state.file, id) }); } catch (e) { setError(errorText(e)); }
  };
  const n = state.style.hidden.length;
  // Versions keep the words only, so today's hidden sections still apply to a restored version.
  const hiddenNote = n ? <Text role="body-sm" muted>{`Versions keep the words only. ${plural(n, "hidden section")} still ${n === 1 ? "applies" : "apply"} after a restore. Show ${n === 1 ? "it" : "them"} again in Content.`}</Text> : null;
  if (!state.versions.length) return <div className="stack">{hiddenNote}<Text role="body" muted>No versions yet. The first edit keeps the original; later saves add a version at most every 10 minutes, and every accepted AI change adds one.</Text></div>;
  const diff = open ? diffLines(open.text, current) : [];
  const changed = diff.filter((d) => d.op !== "same").length;
  return (
    <div className="stack" aria-label="Versions">
      <ul className="list-plain">
        {state.versions.map((v) => (
          <li key={v.id} className="row">
            <span className="grow"><Text role="body" as="div">{VERSION_TEXT[v.kind]}</Text><Text role="body-sm" muted as="div">{fmtDateTime(v.at)}</Text></span>
            <Button size="sm" variant={open?.id === v.id ? "secondary" : "ghost"} onClick={() => void compare(v.id)}>Compare</Button>
            <Button size="sm" variant="ghost" disabled={busy} title={busy ? "Wait for the current save to finish" : undefined} onClick={() => setConfirm(v.id)}>Restore</Button>
          </li>
        ))}
      </ul>
      {hiddenNote}
      {error ? <Text role="body" className="rs-warn">{error}</Text> : null}
      {open ? (
        <div className="stack">
          <Text role="body-sm" muted>{changed ? `${plural(changed, "line")} differ from your current resume. Removed lines are struck through; added lines are marked.` : "Same as your current resume."}</Text>
          <LineDiff before={open.text} after={current} />
        </div>
      ) : null}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title="Restore this version?"
        actions={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => { onRestore(confirm!); setConfirm(null); }}>Restore</Button></>}>
        <Text role="body">Your current resume is kept as a version too, so you can come back to it.</Text>
      </Dialog>
    </div>
  );
}

// ---- Download ----------------------------------------------------------------------

const DOWNLOAD_HELP: Record<ResumeDownload, string> = {
  pdf: "Best for emailing and most job sites.", docx: "For sites and recruiters that ask for Word.",
  md: "Plain Markdown, the same file the studio edits.", txt: "For pasting into application forms: no bullet symbols or formatting.",
};

export function DownloadPanel({ state, flush }: { state: ResumeState; flush(): Promise<boolean> }) {
  const bridge = useBridge();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { if (await flush()) await fn(); } catch (e) { toast({ tone: "danger", text: errorText(e) }); } finally { setBusy(null); }
  };
  return (
    <div className="stack" aria-label="Download">
      <Text role="body-sm" muted>Made on this computer from your saved resume and style. You choose where each file goes.</Text>
      <ul className="list-plain">
        {RESUME_DOWNLOADS.map((f) => (
          <li key={f} className="row">
            <span className="grow"><Text role="body" as="div">{RESUME_DOWNLOAD_TEXT[f]}</Text><Text role="body-sm" muted as="div">{DOWNLOAD_HELP[f]}</Text></span>
            <Button size="sm" loading={busy === f} disabled={busy !== null && busy !== f} onClick={() => void go(f, async () => {
              const r = await bridge.resume.download(state.ref, state.file, f);
              toast(r.saved ? { tone: "success", text: `Saved the ${RESUME_DOWNLOAD_TEXT[f]} file` } : { tone: "neutral", text: "Nothing was saved." });
            })}>Download {RESUME_DOWNLOAD_TEXT[f]}</Button>
          </li>
        ))}
      </ul>
      <div className="row">
        {(["txt", "md"] as const).map((f) => (
          <Button key={f} size="sm" variant="ghost" loading={busy === `copy-${f}`} onClick={() => void go(`copy-${f}`, async () => {
            const ok = await bridge.resume.copy(state.ref, state.file, f);
            toast(ok ? { tone: "success", text: f === "txt" ? "Copied as plain text" : "Copied as Markdown" } : { tone: "neutral", text: "Copying didn't work. Download the file instead." });
          })}>{f === "txt" ? "Copy text" : "Copy Markdown"}</Button>
        ))}
      </div>
    </div>
  );
}
