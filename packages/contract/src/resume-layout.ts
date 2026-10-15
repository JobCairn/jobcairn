/**
 * What goes on the page, in order: one tree that the live preview, the PDF's HTML and the Word file all draw, so
 * they agree on structure (entry lines with their dates, roles, bullets, items and chip groups). Text stays Markdown
 * inline text (bold, italics, links); each renderer turns it into runs, never into markup. Every node carries the
 * id of the model node it came from, so a click on the preview finds its field in the editor.
 */
import { stripInline, type ResumeBlock, type ResumeModel } from "./resume-model.js";
import { resumeTheme, type ResumeStyle } from "./resume-style.js";
import {
  entryView, headerFieldId, headerView, isHidden, itemView, linkLabel, listsAreItems, SECTION_INFO, sectionView, type SectionType,
} from "./resume-view.js";

export interface LayoutBullet { id: string; text: string }
export interface LayoutRole { id: string; title: string; dates: string; bullets: LayoutBullet[] }
export type LayoutItem =
  /**
   * title: the bold line; sub: the line under it (organisation, place, link); dates: shown right, after the title or
   * in a left column. subLead and place split sub for templates that set the place on the right (sub is both, joined).
   */
  | { t: "entry"; id: string; title: string; sub: string; subLead: string; place: string; dates: string; extra: string[]; roles: LayoutRole[]; bullets: LayoutBullet[] }
  | { t: "para"; id: string; text: string }
  | { t: "bullets"; id: string; bullets: LayoutBullet[] }
  | { t: "items"; id: string; items: { id: string; main: string; sub: string; dates: string }[] }
  | { t: "groups"; id: string; groups: { id: string; label: string; chips: string[] }[] }
  | { t: "rule"; id: string }
  | { t: "fixed"; id: string; lines: string[] };
export interface LayoutSection { id: string; heading: string; type: SectionType; items: LayoutItem[] }
export interface LayoutContact { id: string; text: string; href: string | null }
export interface ResumeLayoutDoc {
  name: { id: string; text: string } | null;
  headline: { id: string; text: string } | null;
  contact: LayoutContact[];
  /** Paragraphs and lists under the name that aren't contact details. */
  intro: LayoutItem[];
  sections: LayoutSection[];
}

const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const GLYPH = /^\s*[•●▪◦‣■□➢►]\s*/;
const bullets = (bs: { id: string; text: string }[]) => bs.filter((b) => b.text.trim()).map((b) => ({ id: b.id, text: b.text }));

function plainBlock(b: ResumeBlock): LayoutItem | null {
  if (b.kind === "text") {
    if (b.fixed) return { t: "fixed", id: b.id, lines: b.text.split("\n").filter((l) => !/^\s*(`{3,}|~{3,})/.test(l)) };
    if (RULE.test(b.text)) return { t: "rule", id: b.id };
    const lines = b.text.split("\n");
    // Lines that start with a bullet glyph read as items; other lines join into one paragraph, as Markdown does.
    if (lines.some((l) => GLYPH.test(l))) return { t: "bullets", id: b.id, bullets: lines.map((l, i) => ({ id: `${b.id}:${i}`, text: l.replace(GLYPH, "") })) };
    return b.text.trim() ? { t: "para", id: b.id, text: lines.join(" ") } : null;
  }
  const bs = bullets(b.bullets);
  return bs.length ? { t: "bullets", id: b.id, bullets: bs } : null;
}

/** The page's content for a resume, with hidden sections left out. */
export function resumeLayout(m: ResumeModel, hidden: readonly string[] = []): ResumeLayoutDoc {
  const h = headerView(m);
  const rest = new Set(h.rest);
  const contact: LayoutContact[] = [
    ...(h.location ? [{ id: headerFieldId("location"), text: h.location, href: null }] : []),
    ...(h.email ? [{ id: headerFieldId("email"), text: h.email, href: null }] : []),
    ...(h.phone ? [{ id: headerFieldId("phone"), text: h.phone, href: null }] : []),
    ...h.links.map((l) => { const x = linkLabel(l); const md = /^\[/.test(l.trim()); return { id: headerFieldId("links"), text: md ? x.label : stripInline(l), href: x.href }; }),
    ...h.extras.map((e) => ({ id: headerFieldId("links"), text: e, href: null })),
  ];
  const doc: ResumeLayoutDoc = {
    name: m.header.name !== null && m.header.name.trim() ? { id: headerFieldId("name"), text: m.header.name } : null,
    headline: h.headline ? { id: headerFieldId("headline"), text: h.headline } : null,
    contact,
    intro: m.header.blocks.filter((b) => rest.has(b.id)).map(plainBlock).filter((x): x is LayoutItem => !!x),
    sections: [],
  };
  for (const s of m.sections) {
    if (isHidden(s, hidden)) continue;
    const v = sectionView(s);
    const info = SECTION_INFO[v.type];
    const items: LayoutItem[] = [];
    if (v.shape === "chips") {
      const groups = v.groups.filter((g) => g.chips.length || g.label.trim());
      if (groups.length) items.push({ t: "groups", id: s.id, groups });
      for (const it of v.items) if (it.kind === "entry" || (it.kind === "text" && it.block.fixed)) { const x = it.kind === "entry" ? entryItem(it.entry) : plainBlock(it.block); if (x) items.push(x); }
    } else {
      for (const it of v.items) {
        if (it.kind === "entry") { items.push(entryItem(it.entry)); continue; }
        if (it.kind === "list" && listsAreItems(v.type)) {
          const rows = it.block.bullets.filter((b) => b.text.trim()).map((b) => {
            const iv = itemView(b, v.type);
            const [main = "", ...more] = iv.fields;
            const link = iv.link ? (/^\[/.test(iv.link.trim()) ? linkLabel(iv.link).label : stripInline(iv.link)) : "";
            return { id: b.id, main, sub: [...more, link].filter((x) => x.trim()).join(info.itemSep === ": " ? ", " : " · "), dates: iv.dates };
          });
          if (rows.length) items.push({ t: "items", id: it.id, items: rows });
          continue;
        }
        const x = plainBlock(it.block);
        if (x) items.push(x);
      }
    }
    // A section with nothing in it yet stays in the editor but not on the page.
    if (items.length) doc.sections.push({ id: s.id, heading: s.heading, type: v.type, items });
  }
  return doc;
}

function entryItem(e: ReturnType<typeof entryView>): LayoutItem {
  const multi = e.roles.length > 1;
  const link = e.link ? (/^\[/.test(e.link.trim()) ? linkLabel(e.link).label : stripInline(e.link)) : "";
  // A short line under an entry with no role of its own ("Software Developer") reads as its role.
  const n0 = e.notes[0]?.text.trim() ?? "";
  const noteRole = !e.role && !multi && e.notes.length === 1 && !n0.includes("\n") && n0.length <= 60 && !/[.!?]$/.test(n0) ? n0 : "";
  const role = e.role || noteRole;
  const notes = noteRole ? [] : e.notes.map((n) => n.text.split("\n").join(" "));
  // One role: "Role" with the dates, then "Organisation · Place". Several: the organisation, then each role.
  const title = multi ? e.org || role : role && e.org ? role : e.org || role;
  const org = multi ? "" : role && e.org ? e.org : "";
  const sub = [org, e.location, link].filter((x) => x.trim()).join(" · ");
  const subLead = [org, link].filter((x) => x.trim()).join(" · ");
  return {
    t: "entry", id: e.id, title, sub, subLead, place: e.location.trim(), dates: e.dates, extra: [...e.extra, ...notes],
    roles: multi ? e.roles.map((r, i) => ({ id: r.id, title: r.title, dates: i === 0 ? e.roleDates : r.dates, bullets: bullets(r.bullets) })) : [],
    bullets: multi ? [] : bullets(e.bullets),
  };
}

// ---- Template arrangement --------------------------------------------------------------

/** Short sections that a two-column template sets in its right-hand column. Decided by type, never by heading text. */
export const SIDE_TYPES: readonly SectionType[] = ["skills", "languages", "interests", "certifications", "awards"];

export interface ArrangedLayout {
  /** The full-width column (or the only one), in reading order. */
  main: LayoutSection[];
  /** The right-hand column; empty for one-column templates (and when nothing belongs there). */
  side: LayoutSection[];
}

/**
 * How a template places the sections, shared by the preview, the PDF and the Word file so they agree. The
 * header and intro always come first, then the main column, then the right-hand column: that is also the reading
 * order of every output. "Skills first" moves the summary, then the skills, to the top.
 */
export function arrangeLayout(doc: ResumeLayoutDoc, style: ResumeStyle): ArrangedLayout {
  const t = resumeTheme(style);
  let sections = doc.sections;
  if (t.order === "skills-first") {
    const rank = (s: LayoutSection) => (s.type === "summary" ? 0 : s.type === "skills" ? 1 : 2);
    sections = sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
  }
  if (t.columns === "one") return { main: sections, side: [] };
  const side = sections.filter((s) => SIDE_TYPES.includes(s.type));
  const main = sections.filter((s) => !SIDE_TYPES.includes(s.type));
  // Nothing short to move, or nothing left for the main column: one column reads better.
  if (!side.length || !main.length) return { main: sections, side: [] };
  return { main, side };
}
