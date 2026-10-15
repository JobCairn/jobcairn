import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Button, Pill, Text } from "@careeros/brand";
import {
  ATS_CAUTION_SHORT, ATS_CAUTION_TEXT, isAtsSafe, isTemplateDefault, LAYOUT_HELP, LAYOUT_TEXT, RESUME_LAYOUTS, TEMPLATE_GROUP_TEXT, TEMPLATE_GROUPS, TEMPLATE_INFO, withTemplate,
  type ResumeLayout, type ResumeModel, type ResumeStyle, type TemplateGroup,
} from "@careeros/contract";
import { Segmented } from "./controls";
import { PageThumb } from "./Preview";

type Filter = "all" | TemplateGroup;
const FILTERS: { value: Filter; label: string }[] = [{ value: "all", label: "All" }, ...TEMPLATE_GROUPS.map((g) => ({ value: g, label: TEMPLATE_GROUP_TEXT[g] }))];
/** Width of the larger preview, in CSS pixels. */
const PEEK_W = 340;
const PEEK_DELAY_MS = 250;

function Badge({ layout }: { layout: ResumeLayout }) {
  return isAtsSafe(layout)
    ? <Pill tone="success" title="One column: applicant tracking systems read it in order.">ATS-safe</Pill>
    : <Pill tone="warning" title={ATS_CAUTION_TEXT}>ATS caution</Pill>;
}

/**
 * The template gallery: every template drawn with the person's own resume (the same layout tree as the preview,
 * PDF and Word file), grouped by style, each marked ATS-safe or ATS caution. Hover or keyboard focus shows a larger
 * page. Arrow keys move between templates (up and down by row), Home and End jump to the ends.
 */
export function TemplateGallery({ style, model, onChange }: { style: ResumeStyle; model: ResumeModel; onChange(next: ResumeStyle): void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [peek, setPeek] = useState<{ layout: ResumeLayout; top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // The chosen template always stays in the list, so it can be seen and reached whatever the filter.
  const shown = useMemo(() => RESUME_LAYOUTS.filter((l) => filter === "all" || TEMPLATE_INFO[l].group === filter || l === style.layout), [filter, style.layout]);

  // Beside the gallery, over the live preview, so it never hides the other templates. When the window is too
  // narrow for that (the preview sits under the editor), the cards are already large: no larger page then.
  const place = (el: HTMLElement, layout: ResumeLayout) => {
    const r = el.getBoundingClientRect();
    const g = grid.current?.getBoundingClientRect() ?? r;
    if (g.right + 16 + PEEK_W > window.innerWidth) { setPeek(null); return; }
    const h = PEEK_W * 1.45;
    setPeek({ layout, top: Math.max(8, Math.min(r.top, window.innerHeight - h - 8)), left: g.right + 16 });
  };
  // A fixed panel would drift away from its card on scroll: close it instead.
  useEffect(() => {
    if (!peek) return undefined;
    const close = () => { clearTimeout(timer.current); setPeek(null); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [peek]);
  const show = (el: HTMLElement, layout: ResumeLayout, now = false) => {
    clearTimeout(timer.current);
    if (window.matchMedia?.("(hover: none)").matches && !now) return; // touch: tapping chooses, no hover page
    if (now) place(el, layout);
    else timer.current = setTimeout(() => place(el, layout), PEEK_DELAY_MS);
  };
  const hide = () => { clearTimeout(timer.current); setPeek(null); };

  const choose = (l: ResumeLayout) => onChange(withTemplate(style, l));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { hide(); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return; // Left and Right are the radios' own.
    const inputs = [...(grid.current?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [])];
    const at = inputs.findIndex((i) => i === document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const cols = Math.max(1, grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").filter(Boolean).length : 1);
    const to = e.key === "ArrowDown" ? at + cols : e.key === "ArrowUp" ? at - cols : e.key === "Home" ? 0 : inputs.length - 1;
    const next = inputs[Math.max(0, Math.min(inputs.length - 1, to))];
    if (next && next !== inputs[at]) { next.focus(); choose(next.value as ResumeLayout); }
  };
  /** Keyboard focus shows the larger page at once; a mouse click doesn't (hover already does). */
  const keyboardFocus = (el: HTMLElement) => { try { return el.matches(":focus-visible"); } catch { return false; } };

  return (
    <fieldset className="rs-fieldset">
      <legend className="t-label">Template</legend>
      <Text role="body-sm" muted>
        {`${RESUME_LAYOUTS.length} templates, drawn with your resume. ATS-safe ones are one column, so applicant tracking systems read them in order. The PDF and Word files follow the template you pick.`}
      </Text>
      <Segmented<Filter> label="Show" value={filter} options={FILTERS} onChange={setFilter} />
      <div ref={grid} className="rs-templates" role="radiogroup" aria-label="Template" onKeyDown={onKey}>
        {shown.map((l) => {
          const s = withTemplate(style, l);
          const info = TEMPLATE_INFO[l];
          return (
            <label key={l} className="rs-template" data-layout={l} onMouseEnter={(e) => show(e.currentTarget, l)} onMouseLeave={hide}>
              <input type="radio" name="rs-template" value={l} checked={style.layout === l} onChange={() => choose(l)}
                aria-describedby={`rs-tpl-${l}-help`} onFocus={(e) => { if (keyboardFocus(e.currentTarget)) show(e.currentTarget.closest("label")!, l, true); }} onBlur={hide} />
              <span className="rs-template__page"><PageThumb model={model} style={s} /></span>
              <span className="rs-template__name">{LAYOUT_TEXT[l]}</span>
              <span className="rs-template__meta"><Badge layout={l} /><span className="rs-template__group">{TEMPLATE_GROUP_TEXT[info.group]}</span></span>
              <span className="rs-template__help" id={`rs-tpl-${l}-help`}>{LAYOUT_HELP[l]}{info.twoColumn ? ` ${ATS_CAUTION_SHORT}` : ""}</span>
            </label>
          );
        })}
      </div>
      <Text role="body-sm" muted>
        Picking a template sets its own fonts, headings, spacing, dates and bullets. Your accent colour, page size, text size and hidden sections stay as they are.
      </Text>
      {!isTemplateDefault(style) ? (
        <div className="row">
          <Button size="sm" variant="secondary" aria-label={`Reset to ${LAYOUT_TEXT[style.layout]} defaults`} onClick={() => onChange(withTemplate(style, style.layout))}>Reset style</Button>
          <Text role="body-sm" muted as="span">You changed the type or layout below.</Text>
        </div>
      ) : null}
      {peek ? (
        <div className="rs-peek" aria-hidden="true" style={{ top: `${peek.top}px`, left: `${peek.left}px`, "--peek-w": `${PEEK_W}px` } as CSSProperties}>
          <span className="rs-peek__title">{LAYOUT_TEXT[peek.layout]}</span>
          <PageThumb model={model} style={withTemplate(style, peek.layout)} />
        </div>
      ) : null}
    </fieldset>
  );
}
