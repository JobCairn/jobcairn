import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  arrangeLayout, columnWidths, headingBandTint, inlineRuns, pageBox, RESUME_ON_ACCENT, resumeLayout, resumeTheme, sideTint, themeColor,
  type LayoutBullet, type LayoutItem, type LayoutSection, type ResumeLayoutDoc, type ResumeModel, type ResumeStyle, type ResumeTheme, type ThemeColor,
} from "@careeros/contract";

/** Text runs as React text: nothing from the file (or from Claude) is ever turned into HTML. */
function Runs({ text }: { text: string }) {
  return <>{inlineRuns(text).map((r, i) => (r.bold ? <strong key={i}>{r.italic ? <em>{r.text}</em> : r.text}</strong> : r.italic ? <em key={i}>{r.text}</em> : <span key={i}>{r.text}</span>))}</>;
}

/** Space between two sheets on the desk, in page pixels (before scaling). */
export const SHEET_GAP = 28;

/** Where a run of content sits: the main column (template indent, dates column, skill grid), the side column, or the intro. */
interface Ctx { gutter: boolean; place: boolean; side: boolean; grid: boolean }
const contexts = (t: ResumeTheme): { main: Ctx; side: Ctx; intro: Ctx } => ({
  main: { gutter: t.dates === "gutter", place: t.placeRight, side: false, grid: t.groups === "grid" },
  side: { gutter: false, place: false, side: true, grid: false },
  intro: { gutter: false, place: false, side: false, grid: false },
});

/** An entry or item line. In a left dates column the dates come first, as in the PDF and Word text. */
const Line = ({ title, dates, c }: { title: ReactNode; dates: string; c: Ctx }) => (c.gutter ? (
  <div className="rp-line rp-line--gut">
    <span className="rp-dates">{dates}</span>
    <span className="rp-title">{title}</span>
  </div>
) : (
  <div className="rp-line">
    <span className="rp-title">{title}</span>
    {dates ? <span className="rp-dates">{dates}</span> : null}
  </div>
));
const Bullets = ({ bs, more }: { bs: LayoutBullet[]; more?: boolean }) => (bs.length ? (
  <ul className={`rp-list${more ? " rp-list--more" : ""}`}>{bs.map((b) => <li key={b.id} data-node={b.id} data-unit={more ? "" : undefined}><Runs text={b.text} /></li>)}</ul>
) : null);
/** A block that must not be split from what follows it (an entry's head and its first bullet). */
const Keep = ({ children }: { children: ReactNode }) => <div className="rp-keep" data-unit="">{children}</div>;

function Group({ g, c }: { g: { id: string; label: string; chips: string[] }; c: Ctx }) {
  const chips = g.chips.map((x, k) => <span key={k}>{k ? ", " : ""}<Runs text={x} /></span>);
  if (c.grid) return <div className="rp-group rp-group--grid" data-node={g.id} data-unit="">{g.label ? <strong><Runs text={g.label} /></strong> : null}<span>{chips}</span></div>;
  if (c.side) return <p className="rp-group" data-node={g.id} data-unit="">{g.label ? <strong className="rp-group__label"><Runs text={g.label} /></strong> : null}{chips}</p>;
  return <p className="rp-group" data-node={g.id} data-unit="">{g.label ? <strong><Runs text={g.label} />: </strong> : null}{chips}</p>;
}

function Item({ i, c }: { i: LayoutItem; c: Ctx }) {
  switch (i.t) {
    case "para": return <p className="rp-p" data-node={i.id} data-unit=""><Runs text={i.text} /></p>;
    case "rule": return <hr className="rp-rule" data-unit="" />;
    case "fixed": return <>{i.lines.map((l, k) => <p key={k} className="rp-p" data-node={i.id} data-unit="">{l}</p>)}</>;
    case "bullets": return <ul className="rp-list" data-node={i.id}>{i.bullets.map((b) => <li key={b.id} data-node={b.id} data-unit=""><Runs text={b.text} /></li>)}</ul>;
    case "groups": return <>{i.groups.map((g) => <Group key={g.id} g={g} c={c} />)}</>;
    case "items": return (
      <div className="rp-items">
        {i.items.map((x) => (
          <div key={x.id} className="rp-item" data-node={x.id} data-unit="">
            <Line c={c} dates={x.dates} title={<><Runs text={x.main} />{x.sub ? <span className="rp-rest">, <Runs text={x.sub} /></span> : null}</>} />
          </div>
        ))}
      </div>
    );
    case "entry": {
      const head = (
        <>
          <Line c={c} dates={i.dates} title={<Runs text={i.title} />} />
          {c.place && i.place ? (
            <div className="rp-line rp-subline"><span className="rp-title"><Runs text={i.subLead} /></span><span className="rp-place"><Runs text={i.place} /></span></div>
          ) : i.sub ? <p className="rp-sub"><Runs text={i.sub} /></p> : null}
          {i.extra.map((x, k) => <p key={k} className="rp-sub"><Runs text={x} /></p>)}
        </>
      );
      if (i.roles.length) {
        return (
          <div className="rp-entry" data-node={i.id}>
            {i.roles.map((r, k) => (
              <div key={r.id} className="rp-role" data-node={k ? r.id : undefined}>
                <Keep>{k === 0 ? head : null}<div className="rp-role__line"><Line c={c} dates={r.dates} title={<Runs text={r.title} />} /></div><Bullets bs={r.bullets.slice(0, 1)} /></Keep>
                <Bullets bs={r.bullets.slice(1)} more />
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="rp-entry" data-node={i.id}>
          <Keep>{head}<Bullets bs={i.bullets.slice(0, 1)} /></Keep>
          <Bullets bs={i.bullets.slice(1)} more />
        </div>
      );
    }
  }
}

function Sections({ list, c, serifHeads }: { list: LayoutSection[]; c: Ctx; serifHeads: boolean }) {
  return (
    <>
      {list.map((s) => (
        <section key={s.id} className="rp-section" data-node={s.id}>
          <h2 className={`rp-h2${serifHeads ? " t-display" : ""}`} data-unit=""><Runs text={s.heading} /></h2>
          {s.items.map((x, i) => <Item key={`${x.t}:${x.id}:${i}`} i={x} c={c} />)}
        </section>
      ))}
    </>
  );
}

/**
 * The page's content: header, intro, then the sections (main column, then the side column), placed by the
 * template the same way the PDF and Word file place them. Shared by the live preview and the thumbnails.
 */
function PageBody({ doc, style }: { doc: ResumeLayoutDoc; style: ResumeStyle }) {
  const t = resumeTheme(style);
  const ctx = contexts(t);
  const { main, side } = arrangeLayout(doc, style);
  const serifHeads = t.headingFont === "serif";
  const head = doc.name || doc.headline || doc.contact.length;
  return (
    <>
      {head ? (
        <header className="rp-head">
          {doc.name ? <h1 className={`rp-name${t.nameFont === "serif" ? " t-display" : ""}`} data-node={doc.name.id} data-unit=""><Runs text={doc.name.text} /></h1> : null}
          {doc.headline ? <p className="rp-headline" data-node={doc.headline.id} data-unit=""><Runs text={doc.headline.text} /></p> : null}
          {doc.contact.length ? (
            <p className="rp-contact" data-unit="">{doc.contact.map((c, i) => <span key={i} data-node={c.id}>{i ? <span className="rp-sep" aria-hidden="true">{t.contactSep}</span> : null}<Runs text={c.text} /></span>)}</p>
          ) : null}
        </header>
      ) : null}
      {doc.intro.map((x, i) => <Item key={i} i={x} c={ctx.intro} />)}
      {side.length ? (
        <div className="rp-cols">
          <div className="rp-main"><Sections list={main} c={ctx.main} serifHeads={serifHeads} /></div>
          <aside className="rp-side"><Sections list={side} c={ctx.side} serifHeads={serifHeads} /></aside>
        </div>
      ) : <Sections list={main} c={ctx.main} serifHeads={serifHeads} />}
    </>
  );
}

const colorVar = (t: ResumeTheme, c: ThemeColor) => (c === "text" ? "var(--color-ink-950)" : themeColor(t, c));
const pageVars = (style: ResumeStyle, scale: number): CSSProperties => {
  const t = resumeTheme(style);
  const box = pageBox(style);
  const cols = columnWidths(style);
  const onBand = t.header === "band";
  return {
    "--rp-w": `${box.width}px`, "--rp-h": `${box.height}px`, "--rp-margin": `${box.margin}px`, "--rp-content-h": `${box.contentHeight}px`, "--rp-stride": `${box.height + SHEET_GAP}px`,
    "--rp-base": `${t.basePt}pt`, "--rp-lh": String(t.lineHeight), "--rp-name": `${t.namePt}pt`, "--rp-headline": `${t.headlinePt}pt`, "--rp-h2": `${t.h2Pt}pt`, "--rp-meta": `${t.metaPt}pt`,
    "--rp-section-gap": `${t.sectionGapPt}pt`, "--rp-heading-gap": `${t.headingGapPt}pt`, "--rp-para-gap": `${t.paraGapPt}pt`, "--rp-item-gap": `${t.itemGapPt}pt`, "--rp-entry-gap": `${t.entryGapPt}pt`,
    "--rp-accent": t.accent, "--rp-scale": String(scale), "--rp-bullet": `"${t.bullet}"`, "--rp-heading-weight": String(t.headingWeight), "--rp-name-weight": String(t.nameWeight),
    "--rp-name-color": onBand ? RESUME_ON_ACCENT : colorVar(t, t.nameColor), "--rp-headline-color": onBand ? RESUME_ON_ACCENT : colorVar(t, t.headlineColor),
    "--rp-heading-color": colorVar(t, t.headingColor), "--rp-dates-color": colorVar(t, t.datesColor), "--rp-on-accent": RESUME_ON_ACCENT,
    "--rp-band-tint": headingBandTint(t), "--rp-side-tint": sideTint(t), "--rp-band-pad": `${t.bandPadPt}pt`, "--rp-bar": `${t.barPt}pt`,
    "--rp-indent": `${t.indentPt + (t.dates === "gutter" ? t.gutterPt : 0)}pt`, "--rp-gutter": `${t.gutterPt}pt`, "--rp-group-label": `${t.groupLabelPt}pt`,
    "--rp-side-w": `${cols.side}pt`, "--rp-col-gap": `${cols.gap}pt`, "--rp-side-pad": `${t.sidePadPt}pt`,
  } as CSSProperties;
};
const pageClass = (style: ResumeStyle, linked: boolean) => {
  const t = resumeTheme(style);
  return [
    "rp-page", `rp-name--${t.nameAlign}`, `rp-case--${t.headingCase}`, `rp-rule--${t.rule}`, `rp-halign--${t.headingAlign}`, `rp-header--${t.header}`,
    t.band ? "rp-band" : "", `rp-hfont--${t.headingFont}`, `rp-nfont--${t.nameFont}`, t.bodyFont === "text-serif" ? "t-text-serif" : "", `rp-dates--${t.dates}`, t.subItalic ? "rp-sub--italic" : "", `rp-side--${t.side}`,
    `rp-layout--${style.layout}`, linked ? "is-linked" : "",
  ].filter(Boolean).join(" ");
};

/** The first page of a resume, scaled to its box: for file tiles. Decorative (the tile names the file). */
export function PageThumb({ model, style }: { model: ResumeModel; style: ResumeStyle }) {
  const doc = useMemo(() => resumeLayout(model, style.hidden), [model, style.hidden]);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const box = pageBox(style);
  const t = resumeTheme(style);
  useLayoutEffect(() => {
    const measure = () => { const w = wrap.current?.clientWidth ?? 0; if (w > 0) setScale(w / box.width); };
    measure();
    if (typeof ResizeObserver === "undefined" || !wrap.current) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [box.width]);
  return (
    <div ref={wrap} className="rp-thumb" style={{ ...pageVars(style, scale), height: `${box.height * scale}px` }} aria-hidden="true">
      <div className={pageClass(style, false)} style={{ height: `${box.height}px` }}>
        <div className="rp-sheet" style={{ top: 0 }} />
        <div className="rp-body"><PageBody doc={doc} style={style} /></div>
      </div>
    </div>
  );
}

export interface PreviewProps {
  model: ResumeModel;
  style: ResumeStyle;
  onPages?(pages: number): void;
  /** Click on a part of the page: the id of the field it came from. */
  onPick?(id: string): void;
  /** Ids to highlight and scroll to, most specific first (the first one on the page wins). */
  selected?: string[];
  /** Measure only: drawn off screen at full size, for Fit to pages. */
  measureOnly?: boolean;
}

/**
 * Lays units out page by page: a unit that would cross the bottom of a page moves to the next page, and a section
 * heading moves with it. Returns the number of pages. Positions are in page pixels (before scaling).
 */
export function paginate(body: HTMLElement, contentH: number, stride: number, scale: number): number {
  const units = [...body.querySelectorAll<HTMLElement>("[data-unit]")];
  for (const u of units) u.style.marginTop = "";
  const top0 = body.getBoundingClientRect().top;
  const pos = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { top: (r.top - top0) / scale, bottom: (r.bottom - top0) / scale }; };
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const { top, bottom } = pos(u);
    if (bottom - top > contentH) continue; // taller than a page: nothing to gain
    const page = Math.floor(top / stride);
    const end = page * stride + contentH;
    if (bottom <= end + 0.5) continue;
    // Keep a section heading with the first thing under it.
    const prev = units[i - 1];
    const heading = prev?.matches(".rp-h2") && !prev.style.marginTop && Math.floor(pos(prev).top / stride) === page ? prev : null;
    const target = heading ?? u;
    const base = parseFloat(getComputedStyle(target).marginTop) || 0;
    const m = (page + 1) * stride - pos(target).top + base;
    target.style.marginTop = `${m}px`;
    // Collapsing margins can eat part of it: correct once against where it really landed.
    const off = (page + 1) * stride - pos(target).top;
    if (Math.abs(off) > 0.5) target.style.marginTop = `${m + off}px`;
    if (heading) i--; // measure this unit again, now under its heading
  }
  // The side column's tint is drawn per page (it skips the desk between sheets), measured from the column's top.
  const side = body.querySelector<HTMLElement>(".rp-side");
  if (side) side.style.setProperty("--rp-side-top", `${(side.getBoundingClientRect().top - top0) / scale}px`);
  const height = body.getBoundingClientRect().height / scale;
  return Math.max(1, Math.floor(Math.max(0, height - 0.5) / stride) + 1);
}

/**
 * A live page: the same theme numbers and the same layout tree the PDF uses, drawn at real size and scaled to fit,
 * one sheet per page. An entry's head is never split from its first bullet. Click a part to edit it.
 */
export function Preview({ model, style, onPages, onPick, selected, measureOnly }: PreviewProps) {
  const t = resumeTheme(style);
  const box = pageBox(style);
  const doc: ResumeLayoutDoc = useMemo(() => resumeLayout(model, style.hidden), [model, style.hidden]);
  const wrap = useRef<HTMLDivElement>(null);
  const desk = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pages, setPages] = useState(1);
  const stride = box.height + SHEET_GAP;
  const k = measureOnly ? 1 : scale;

  useLayoutEffect(() => {
    if (measureOnly) return undefined;
    const measure = () => { const w = wrap.current?.clientWidth ?? 0; if (w > 0) setScale(Math.min(1, w / box.width)); };
    measure();
    if (typeof ResizeObserver === "undefined" || !wrap.current) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [box.width, measureOnly]);

  const run = () => {
    if (!body.current) return;
    const p = paginate(body.current, box.contentHeight, stride, k);
    setPages(p);
    if (measureOnly) onPages?.(p);
  };
  const latest = useRef(run);
  latest.current = run;
  useLayoutEffect(run, [doc, style, k]); // eslint-disable-line react-hooks/exhaustive-deps
  // Web fonts can arrive after the first layout; lay out again when they do (with the latest scale).
  useEffect(() => { let on = true; void document.fonts?.ready.then(() => { if (on) latest.current(); }); return () => { on = false; }; }, []);
  useLayoutEffect(() => { if (!measureOnly) onPages?.(pages); }, [pages, onPages, measureOnly]);

  // Highlight the selected part and bring it into view.
  const sel = selected?.join("|") ?? "";
  useEffect(() => {
    const root = body.current;
    if (!root || measureOnly) return;
    root.querySelectorAll(".is-selected").forEach((el) => el.classList.remove("is-selected"));
    const el = (selected ?? []).map((id) => root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)).find(Boolean);
    if (!el) return;
    el.classList.add("is-selected");
    const d = desk.current;
    if (!d) return;
    const r = el.getBoundingClientRect(), dr = d.getBoundingClientRect();
    if (r.top < dr.top + 24 || r.bottom > dr.bottom - 24) d.scrollTo?.({ top: d.scrollTop + r.top - dr.top - dr.height / 3, behavior: "smooth" });
  }, [sel, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const click = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    if (el?.dataset.node) onPick?.(el.dataset.node);
  };

  const vars = pageVars(style, k);
  const cls = pageClass(style, !!onPick);
  const sheetH = pages * box.height + (pages - 1) * SHEET_GAP;

  const page = (
    <article className={cls} aria-label={measureOnly ? undefined : "Page preview"} style={{ height: `${sheetH}px` }} onClick={onPick ? click : undefined}>
      {Array.from({ length: pages }, (_x, i) => (
        <div key={i} className="rp-sheet" style={{ top: `${i * stride}px` }} aria-hidden="true">{pages > 1 ? <span className="rp-sheet__no">Page {i + 1} of {pages}</span> : null}</div>
      ))}
      <div ref={body} className="rp-body"><PageBody doc={doc} style={style} /></div>
    </article>
  );

  if (measureOnly) return <div className="rp-measure" style={vars} aria-hidden="true">{page}</div>;
  return (
    <div ref={desk} className="rp-desk" style={vars}>
      <div ref={wrap} className="rp-fit">
        <div className="rp-scaler" style={{ height: `${sheetH * scale}px` }}>{page}</div>
      </div>
    </div>
  );
}
