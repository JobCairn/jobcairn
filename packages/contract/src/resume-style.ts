/**
 * Resume look, stored as <name>.style.json next to the Markdown: a template plus a few knobs (fonts, accent, density,
 * margins, text size, heading style, date alignment, bullet style, page size) and the hidden sections. Every value
 * is picked from a fixed list, so nothing free-form ever reaches CSS or a Word file. `resumeTheme` turns a style
 * into the numbers the print HTML, the DOCX writer and the live preview all use, so the three agree.
 */

/**
 * Templates. Single column is the default: real text, standard headings, one reading order, so applicant tracking
 * systems read them. "sidebar" and "split" add a right-hand column for short sections; they are marked
 * "ATS caution" in the gallery because some older systems read two columns out of order.
 */
export const RESUME_LAYOUTS = [
  "classic", "modern", "compact", "executive", "technical", "minimal",
  "engineer", "headline", "banner", "open", "skills", "plain", "swiss", "timeline", "scholar", "sidebar", "split",
] as const;
export type ResumeLayout = (typeof RESUME_LAYOUTS)[number];
/**
 * Font pairings, from the bundled OFL fonts only (Geist, Instrument Serif and Source Serif 4). "geist": Geist
 * throughout. "bold": Geist with heavier headings. "serif": Instrument Serif name and headings, Geist text.
 * "serif-name": Instrument Serif for the name only. "serif-text": Instrument Serif name and headings, Source Serif 4
 * text. Monospace is never used on a resume page. Instrument Serif is a display face, so it never sets body text.
 */
export const RESUME_FONTS = ["geist", "bold", "serif", "serif-name", "serif-text"] as const;
export type ResumeFont = (typeof RESUME_FONTS)[number];
/** Print-safe accents, each at least 7:1 against white. */
export const RESUME_ACCENTS = {
  ink: "#1a1a1a", navy: "#1f3a5f", teal: "#0f4f54", wine: "#6b1e2e", forest: "#24502e", slate: "#3b4252", plum: "#4a2357", umber: "#5a3a1a",
} as const;
export type ResumeAccent = keyof typeof RESUME_ACCENTS;
export const RESUME_ACCENT_IDS = Object.keys(RESUME_ACCENTS) as ResumeAccent[];
export const RESUME_DENSITIES = ["relaxed", "standard", "tight"] as const;
export type ResumeDensity = (typeof RESUME_DENSITIES)[number];
export const RESUME_MARGINS = ["wide", "normal", "narrow"] as const;
export type ResumeMargins = (typeof RESUME_MARGINS)[number];
/** Text size, relative to the density's base size. */
export const RESUME_SIZES = ["large", "normal", "small", "smaller"] as const;
export type ResumeSize = (typeof RESUME_SIZES)[number];
/**
 * Section headings: capitals with a rule under them, capitals only, plain, capitals on a light band, capitals under
 * a heavy rule, or centred capitals with a rule.
 */
export const RESUME_HEADINGS = ["rule", "caps", "plain", "band", "above", "center"] as const;
export type ResumeHeadings = (typeof RESUME_HEADINGS)[number];
/** Where entry dates go: flush right on the entry's line, after the title, or in a column on the left. */
export const RESUME_DATES = ["right", "inline", "gutter"] as const;
export type ResumeDates = (typeof RESUME_DATES)[number];
export const RESUME_BULLETS = ["dot", "dash", "square"] as const;
export type ResumeBullets = (typeof RESUME_BULLETS)[number];
export const RESUME_PAGES = ["a4", "letter"] as const;
export type ResumePage = (typeof RESUME_PAGES)[number];
export const MAX_HIDDEN_SECTIONS = 50;

export interface ResumeStyle {
  layout: ResumeLayout; font: ResumeFont; accent: ResumeAccent; density: ResumeDensity; margins: ResumeMargins; size: ResumeSize;
  headings: ResumeHeadings; dates: ResumeDates; bullets: ResumeBullets; page: ResumePage; hidden: string[];
}

type Preset = Pick<ResumeStyle, "font" | "density" | "margins" | "headings" | "dates" | "bullets">;
/**
 * What choosing a template sets. Accent, page size, text size and hidden sections stay as they were: a template
 * resets its own type and spacing, never the person's colour or page.
 */
export const TEMPLATE_PRESETS: Record<ResumeLayout, Preset> = {
  classic: { font: "geist", density: "standard", margins: "normal", headings: "rule", dates: "right", bullets: "dot" },
  modern: { font: "bold", density: "standard", margins: "normal", headings: "plain", dates: "right", bullets: "dot" },
  compact: { font: "geist", density: "tight", margins: "narrow", headings: "rule", dates: "right", bullets: "dot" },
  executive: { font: "serif-text", density: "relaxed", margins: "wide", headings: "rule", dates: "right", bullets: "dot" },
  technical: { font: "geist", density: "standard", margins: "normal", headings: "band", dates: "right", bullets: "square" },
  minimal: { font: "geist", density: "standard", margins: "wide", headings: "caps", dates: "inline", bullets: "dash" },
  engineer: { font: "geist", density: "tight", margins: "narrow", headings: "rule", dates: "right", bullets: "dot" },
  headline: { font: "bold", density: "standard", margins: "normal", headings: "caps", dates: "right", bullets: "dot" },
  banner: { font: "bold", density: "standard", margins: "normal", headings: "plain", dates: "right", bullets: "dot" },
  open: { font: "geist", density: "relaxed", margins: "wide", headings: "caps", dates: "right", bullets: "dash" },
  skills: { font: "geist", density: "standard", margins: "normal", headings: "caps", dates: "right", bullets: "dot" },
  plain: { font: "geist", density: "relaxed", margins: "normal", headings: "plain", dates: "right", bullets: "dot" },
  swiss: { font: "bold", density: "standard", margins: "normal", headings: "above", dates: "right", bullets: "dash" },
  timeline: { font: "geist", density: "standard", margins: "normal", headings: "caps", dates: "gutter", bullets: "dot" },
  scholar: { font: "serif-text", density: "relaxed", margins: "wide", headings: "center", dates: "right", bullets: "dot" },
  sidebar: { font: "bold", density: "standard", margins: "normal", headings: "caps", dates: "right", bullets: "dot" },
  split: { font: "geist", density: "standard", margins: "normal", headings: "rule", dates: "right", bullets: "dot" },
};

export const DEFAULT_RESUME_STYLE: ResumeStyle = { layout: "classic", ...TEMPLATE_PRESETS.classic, accent: "ink", size: "normal", page: "a4", hidden: [] };

/** A style with a template applied: the template's preset, keeping the person's accent, page, text size and hidden sections. */
export const withTemplate = (style: ResumeStyle, layout: ResumeLayout): ResumeStyle => ({ ...style, layout, ...TEMPLATE_PRESETS[layout] });
/** True when the type and spacing still match the template's own (nothing to reset). */
export const isTemplateDefault = (style: ResumeStyle): boolean => {
  const p = TEMPLATE_PRESETS[style.layout];
  return (Object.keys(p) as (keyof Preset)[]).every((k) => style[k] === p[k]);
};

/** Gallery groups, in the order the filter shows them. */
export const TEMPLATE_GROUPS = ["professional", "modern", "creative", "compact", "academic"] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];
export const TEMPLATE_GROUP_TEXT: Record<TemplateGroup, string> = { professional: "Professional", modern: "Modern", creative: "Creative", compact: "Compact", academic: "Academic" };
export interface TemplateInfo {
  group: TemplateGroup;
  /** Two columns: some older applicant tracking systems read them out of order. */
  twoColumn: boolean;
  /** Black and white only: the accent colour doesn't apply. */
  mono: boolean;
}
export const TEMPLATE_INFO: Record<ResumeLayout, TemplateInfo> = {
  classic: { group: "professional", twoColumn: false, mono: false },
  modern: { group: "modern", twoColumn: false, mono: false },
  compact: { group: "compact", twoColumn: false, mono: false },
  executive: { group: "academic", twoColumn: false, mono: false },
  technical: { group: "compact", twoColumn: false, mono: false },
  minimal: { group: "modern", twoColumn: false, mono: false },
  engineer: { group: "compact", twoColumn: false, mono: false },
  headline: { group: "modern", twoColumn: false, mono: false },
  banner: { group: "modern", twoColumn: false, mono: false },
  open: { group: "modern", twoColumn: false, mono: false },
  skills: { group: "professional", twoColumn: false, mono: false },
  plain: { group: "professional", twoColumn: false, mono: true },
  swiss: { group: "creative", twoColumn: false, mono: true },
  timeline: { group: "creative", twoColumn: false, mono: false },
  scholar: { group: "academic", twoColumn: false, mono: false },
  sidebar: { group: "creative", twoColumn: true, mono: false },
  split: { group: "modern", twoColumn: true, mono: false },
};
/** Single-column templates: one reading order, real text, standard headings. */
export const isAtsSafe = (layout: ResumeLayout): boolean => !TEMPLATE_INFO[layout].twoColumn;
export const ATS_CAUTION_SHORT = "Two columns: some older applicant tracking systems read them out of order.";
export const ATS_CAUTION_TEXT = "Two columns. Some older applicant tracking systems read the columns out of order. Use a one-column template when a job site asks for plain text.";

export const LAYOUT_TEXT: Record<ResumeLayout, string> = {
  classic: "Classic", modern: "Modern", compact: "Compact", executive: "Executive", technical: "Technical", minimal: "Minimal",
  engineer: "Engineer", headline: "Headline", banner: "Banner", open: "Open", skills: "Skills first", plain: "Plain", swiss: "Swiss",
  timeline: "Timeline", scholar: "Scholar", sidebar: "Sidebar", split: "Split",
};
export const LAYOUT_HELP: Record<ResumeLayout, string> = {
  classic: "Centred name, ruled headings. Safe for any role.",
  modern: "Name in the accent colour, plain headings.",
  compact: "Tight spacing, narrow margins. Fits more.",
  executive: "Serif name and headings, roomy spacing.",
  technical: "Headings on a light band, square bullets.",
  minimal: "Quiet capitals, dates after the title.",
  engineer: "Dense and centred. Places and dates line up on the right.",
  headline: "Large name under an accent bar.",
  banner: "Name and contact details on a solid colour band.",
  open: "Light name, lots of white space, quiet headings.",
  skills: "Summary and skills come first. Good for a career change.",
  plain: "Black and white, plain headings. For government and older systems.",
  swiss: "Black and white grid. Heavy rules, content set in from the left.",
  timeline: "Dates in a column on the left, like a timeline.",
  scholar: "Serif headings centred between rules. Academic and finance.",
  sidebar: "Skills and languages in a coloured column on the right.",
  split: "A ruled column on the right for skills and short lists.",
};
export const FONT_TEXT: Record<ResumeFont, string> = { geist: "Geist", bold: "Geist, bold headings", serif: "Instrument Serif and Geist", "serif-name": "Serif name, Geist text", "serif-text": "Instrument Serif and Source Serif" };
export const ACCENT_TEXT: Record<ResumeAccent, string> = { ink: "Ink", navy: "Navy", teal: "Teal", wine: "Wine", forest: "Forest", slate: "Slate", plum: "Plum", umber: "Umber" };
export const DENSITY_TEXT: Record<ResumeDensity, string> = { relaxed: "Relaxed", standard: "Standard", tight: "Tight" };
export const MARGINS_TEXT: Record<ResumeMargins, string> = { wide: "Wide", normal: "Normal", narrow: "Narrow" };
export const SIZE_TEXT: Record<ResumeSize, string> = { large: "Large", normal: "Normal", small: "Small", smaller: "Smaller" };
export const HEADINGS_TEXT: Record<ResumeHeadings, string> = { rule: "Capitals with a rule", caps: "Capitals", plain: "Plain", band: "Capitals on a band", above: "Capitals under a heavy rule", center: "Centred with a rule" };
export const DATES_TEXT: Record<ResumeDates, string> = { right: "Right-aligned", inline: "After the title", gutter: "Left column" };
export const BULLETS_TEXT: Record<ResumeBullets, string> = { dot: "Dot", dash: "Dash", square: "Square" };
export const PAGE_TEXT: Record<ResumePage, string> = { a4: "A4", letter: "US Letter" };

const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);

/** Reads a style file's JSON defensively: anything unknown falls back to the default. Older files keep their look. */
export function parseResumeStyle(v: unknown): ResumeStyle {
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const layout = pick(RESUME_LAYOUTS, o.layout, DEFAULT_RESUME_STYLE.layout);
  // Older files have only layout, font, accent, density and page: the rest comes from their template.
  const d: ResumeStyle = { ...DEFAULT_RESUME_STYLE, ...TEMPLATE_PRESETS[layout], layout };
  const hidden = Array.isArray(o.hidden)
    ? [...new Set(o.hidden.filter((h): h is string => typeof h === "string" && h.length > 0 && h.length <= 120 && !/[\u0000-\u001f]/.test(h)))].slice(0, MAX_HIDDEN_SECTIONS)
    : [];
  // "mono" headings were offered once; a resume page never uses monospace now.
  const font = o.font === "mono" ? "geist" : pick(RESUME_FONTS, o.font, d.font);
  return {
    layout, font,
    accent: pick(RESUME_ACCENT_IDS, o.accent, d.accent), density: pick(RESUME_DENSITIES, o.density, d.density),
    margins: pick(RESUME_MARGINS, o.margins, d.margins), size: pick(RESUME_SIZES, o.size, d.size),
    headings: pick(RESUME_HEADINGS, o.headings, d.headings), dates: pick(RESUME_DATES, o.dates, d.dates),
    bullets: pick(RESUME_BULLETS, o.bullets, d.bullets), page: pick(RESUME_PAGES, o.page, d.page), hidden,
  };
}

export type ThemeFont = "sans" | "serif";
export type ThemeColor = "text" | "accent" | "muted";
/** Muted grey for quiet headings: 7:1 against white. */
export const RESUME_MUTED = "#4a4a4a";
/** Text on the banner: white on any accent (each accent is at least 7:1 against white). */
export const RESUME_ON_ACCENT = "#ffffff";
export interface ResumeTheme {
  page: { css: "A4" | "Letter"; widthMm: number; heightMm: number; marginIn: number };
  /** Body size in points and line height (unitless). */
  basePt: number; lineHeight: number;
  namePt: number; headlinePt: number; h2Pt: number; h3Pt: number; metaPt: number;
  /** Space above a section, under a heading, after a paragraph, between bullets and between entries, in points. */
  sectionGapPt: number; headingGapPt: number; paraGapPt: number; itemGapPt: number; entryGapPt: number;
  accent: string;
  nameAlign: "left" | "center";
  nameColor: ThemeColor;
  nameWeight: 400 | 600 | 700;
  headlineColor: ThemeColor;
  headingColor: ThemeColor;
  headingCase: "upper" | "none";
  headingAlign: "left" | "center";
  /** Where the section rule goes: under the heading (thin) or over it (heavy). */
  rule: "below" | "above" | "none";
  /** A light accent band behind section headings. */
  band: boolean;
  nameFont: ThemeFont;
  headingFont: ThemeFont;
  /** Body text: Geist, or Source Serif 4 (a text serif, for long reading). */
  bodyFont: "sans" | "text-serif";
  headingWeight: 400 | 600 | 700;
  dates: ResumeDates;
  datesColor: ThemeColor;
  /** The bullet glyph drawn on the page (Word uses its own list bullets). */
  bullet: "•" | "–" | "▪";
  /** Between contact details on the header line. */
  contactSep: string;
  /**
   * The header: plain; "band" (name and contact on a solid accent band, white text); "bar" (a heavy accent bar
   * over the name); "rule" (a thin rule under the contact line).
   */
  header: "plain" | "band" | "bar" | "rule";
  /** Band padding and bar thickness, in points (they shrink with the spacing). */
  bandPadPt: number; barPt: number;
  /** Section content set in from the left (headings stay at the edge), in points. */
  indentPt: number;
  /** Width of the dates column when dates are in a left column, in points. */
  gutterPt: number;
  /** An entry's second line: organisation on the left, its place on the right. */
  placeRight: boolean;
  /** The organisation line in italics. */
  subItalic: boolean;
  /** Skill groups: "Label: a, b" on one line, or labels in a column of their own. */
  groups: "inline" | "grid";
  /** Width of the skill label column, in points. */
  groupLabelPt: number;
  /** Section order: as written, or summary then skills first. */
  order: "written" | "skills-first";
  /** One column, or a column on the right for short sections. */
  columns: "one" | "right";
  /** The right column: width as a share of the page's text width, gap, and whether it is tinted or ruled. */
  sideShare: number; colGapPt: number; sidePadPt: number; side: "tint" | "rule" | "none";
}

const DENSITY: Record<ResumeDensity, { pt: number; lh: number; k: number }> = {
  relaxed: { pt: 11, lh: 1.45, k: 1.25 }, standard: { pt: 10.5, lh: 1.38, k: 1 }, tight: { pt: 10, lh: 1.3, k: 0.72 },
};
const SIZE_DELTA: Record<ResumeSize, number> = { large: 0.5, normal: 0, small: -0.5, smaller: -1 };
const MARGIN_IN: Record<ResumeMargins, number> = { wide: 0.9, normal: 0.7, narrow: 0.5 };
const BULLET: Record<ResumeBullets, ResumeTheme["bullet"]> = { dot: "•", dash: "–", square: "▪" };
const round = (n: number) => Math.round(n * 10) / 10;

/** A template's own look, beyond the knobs it presets. Anything left out takes the classic single-column default. */
interface Look {
  nameAlign: "left" | "center"; nameColor: ThemeColor; headingColor: ThemeColor; contactSep: string;
  /** Name size as a multiple of the body size. */
  name: number;
  nameWeight?: 400 | 600 | 700; headlineColor?: ThemeColor; datesColor?: ThemeColor; header?: ResumeTheme["header"];
  /** Section content indent as a share of the text width. */
  indent?: number;
  placeRight?: boolean; subItalic?: boolean; groups?: ResumeTheme["groups"]; order?: ResumeTheme["order"];
  side?: ResumeTheme["side"];
  /** Extra white space between sections (multiplies the density's spacing). */
  space?: number;
  /** Section heading size as a multiple of the usual. */
  h2?: number;
}
const LOOK: Record<ResumeLayout, Look> = {
  classic: { nameAlign: "center", nameColor: "text", headingColor: "text", contactSep: " · ", name: 1.75 },
  modern: { nameAlign: "left", nameColor: "accent", headingColor: "accent", contactSep: " · ", name: 2.1 },
  compact: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " | ", name: 1.6 },
  executive: { nameAlign: "center", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2 },
  technical: { nameAlign: "left", nameColor: "text", headingColor: "text", contactSep: " | ", name: 1.8 },
  minimal: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 1.7 },
  engineer: { nameAlign: "center", nameColor: "text", headingColor: "text", contactSep: " | ", name: 2.4, nameWeight: 700, placeRight: true },
  headline: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2.7, nameWeight: 700, headlineColor: "accent", header: "bar" },
  banner: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2.3, header: "band", h2: 1.08 },
  open: { nameAlign: "left", nameColor: "text", headingColor: "muted", contactSep: " · ", name: 2.6, nameWeight: 400, space: 1.35, h2: 0.9, subItalic: false },
  skills: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2, headlineColor: "accent", header: "rule", groups: "grid", order: "skills-first" },
  plain: { nameAlign: "left", nameColor: "text", headingColor: "text", contactSep: " | ", name: 1.5, subItalic: false },
  swiss: { nameAlign: "left", nameColor: "text", headingColor: "text", contactSep: " / ", name: 2.9, nameWeight: 700, indent: 0.22, subItalic: false },
  timeline: { nameAlign: "left", nameColor: "accent", headingColor: "accent", contactSep: " · ", name: 2, datesColor: "accent" },
  scholar: { nameAlign: "center", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2.1 },
  sidebar: { nameAlign: "left", nameColor: "accent", headingColor: "accent", contactSep: " · ", name: 2.2, side: "tint" },
  split: { nameAlign: "left", nameColor: "text", headingColor: "accent", contactSep: " · ", name: 2, side: "rule" },
};

/** The page's text width in points (inside the margins). */
const textWidthPt = (style: ResumeStyle): number => {
  const w = style.page === "letter" ? 215.9 : 210;
  return (w / 25.4) * 72 - 2 * (MARGIN_IN[style.margins] ?? 0.7) * 72;
};

export function resumeTheme(style: ResumeStyle): ResumeTheme {
  const d = DENSITY[style.density] ?? DENSITY.standard;
  const look = LOOK[style.layout] ?? LOOK.classic;
  const info = TEMPLATE_INFO[style.layout] ?? TEMPLATE_INFO.classic;
  const base = d.pt + (SIZE_DELTA[style.size] ?? 0);
  const k = d.k;
  const sk = k * (look.space ?? 1);
  const serifHeads = style.font === "serif" || style.font === "serif-text";
  const serifName = serifHeads || style.font === "serif-name";
  const h = style.headings;
  const margin = MARGIN_IN[style.margins] ?? 0.7;
  const textW = textWidthPt(style);
  const columns = info.twoColumn ? "right" : "one";
  const h2k = look.h2 ?? 1;
  return {
    page: style.page === "letter" ? { css: "Letter", widthMm: 215.9, heightMm: 279.4, marginIn: margin } : { css: "A4", widthMm: 210, heightMm: 297, marginIn: margin },
    basePt: base, lineHeight: d.lh,
    // Instrument Serif is light and narrow, so it is set larger to carry the same weight.
    namePt: round(base * look.name * (serifName ? 1.15 : 1)), headlinePt: round(base * 1.08),
    h2Pt: round(base * h2k * (serifHeads ? 1.3 : h === "plain" ? 1.18 : 1.05)), h3Pt: base, metaPt: round(base * 0.95),
    sectionGapPt: round(12 * sk), headingGapPt: round(5 * k), paraGapPt: round(4 * k), itemGapPt: round(2.5 * k), entryGapPt: round(7 * sk),
    accent: info.mono ? RESUME_ACCENTS.ink : RESUME_ACCENTS[style.accent] ?? RESUME_ACCENTS.ink,
    nameAlign: look.nameAlign, nameColor: look.nameColor, headingColor: look.headingColor, contactSep: look.contactSep,
    nameWeight: serifName ? 400 : look.nameWeight ?? (style.font === "bold" ? 700 : 600),
    headlineColor: look.headlineColor ?? "text",
    headingCase: h === "plain" ? "none" : "upper",
    headingAlign: h === "center" ? "center" : "left",
    rule: h === "rule" || h === "center" ? "below" : h === "above" ? "above" : "none",
    band: h === "band",
    nameFont: serifName ? "serif" : "sans",
    headingFont: serifHeads ? "serif" : "sans",
    bodyFont: style.font === "serif-text" ? "text-serif" : "sans",
    headingWeight: serifHeads ? 400 : style.font === "bold" ? 700 : 600,
    dates: style.dates, datesColor: look.datesColor ?? "text",
    bullet: BULLET[style.bullets] ?? "•",
    header: look.header ?? "plain",
    bandPadPt: round(8 * k), barPt: 4,
    indentPt: round(textW * (look.indent ?? 0)),
    gutterPt: round(Math.max(84, textW * 0.21) * (base / 10.5)),
    placeRight: look.placeRight ?? false,
    subItalic: look.subItalic ?? true,
    groups: look.groups ?? "inline", groupLabelPt: round(textW * 0.2),
    order: look.order ?? "written",
    columns, sideShare: 0.3, colGapPt: round(14 * k), sidePadPt: look.side === "tint" ? round(8 * k) : look.side === "rule" ? round(10 * k) : 0, side: look.side ?? "none",
  };
}

/** A colour mixed with white: `share` of the colour (0 to 1). Print-safe tints for bands and the side column. */
export function tint(hex: string, share: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * share + 255 * (1 - share)).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
/** The light band behind "band" headings and the tinted side column. */
export const headingBandTint = (t: ResumeTheme): string => tint(t.accent, 0.08);
export const sideTint = (t: ResumeTheme): string => tint(t.accent, 0.07);

/** The colour a theme colour role draws in. */
export const themeColor = (t: ResumeTheme, c: ThemeColor): string => (c === "accent" ? t.accent : c === "muted" ? RESUME_MUTED : "#000000");

/** Column widths in points: the main column, and the right-hand column (0 for one column). */
export function columnWidths(style: ResumeStyle): { main: number; side: number; gap: number } {
  const t = resumeTheme(style);
  const w = textWidthPt(style);
  if (t.columns === "one") return { main: w, side: 0, gap: 0 };
  const side = round(w * t.sideShare);
  return { main: round(w - side - t.colGapPt), side, gap: t.colGapPt };
}

const PX_PER_MM = 96 / 25.4;
/** The page in CSS pixels (96 per inch) and the area inside the margins, for the preview and the page count. */
export function pageBox(style: ResumeStyle): { width: number; height: number; margin: number; contentWidth: number; contentHeight: number } {
  const t = resumeTheme(style).page;
  const width = t.widthMm * PX_PER_MM;
  const height = t.heightMm * PX_PER_MM;
  const margin = t.marginIn * 96;
  return { width, height, margin, contentWidth: width - 2 * margin, contentHeight: height - 2 * margin };
}
/** How many pages content this tall (CSS pixels) fills. Never fewer than one. */
export function pagesFor(contentPx: number, style: ResumeStyle): number {
  const h = pageBox(style).contentHeight;
  return Math.max(1, Math.ceil((Math.max(0, contentPx) - 0.5) / h));
}
export const PAGE_WARNING_OVER = 2;

// ---- Fit to N pages ------------------------------------------------------------------

/**
 * The styles "Fit to N pages" tries, in order, each one tighter than the last: density first, then margins, then
 * text size. Every step keeps the earlier ones, so the list ends at the tightest style the controls allow.
 */
export function fitSteps(style: ResumeStyle): ResumeStyle[] {
  const out: ResumeStyle[] = [];
  let s = style;
  const step = <K extends "density" | "margins" | "size">(key: K, list: readonly ResumeStyle[K][]) => {
    for (let i = list.indexOf(s[key]) + 1; i < list.length; i++) { s = { ...s, [key]: list[i] }; out.push(s); }
  };
  step("density", RESUME_DENSITIES);
  step("margins", RESUME_MARGINS);
  step("size", RESUME_SIZES);
  return out;
}

export interface FitResult {
  style: ResumeStyle;
  pages: number;
  /** True when the resume fits in the pages asked for. */
  fits: boolean;
  /** What changed, one phrase per control ("spacing tight"); empty when nothing had to. */
  changes: string[];
}

/** The final differences between two styles, one phrase per control. */
export function fitChanges(from: ResumeStyle, to: ResumeStyle): string[] {
  const out: string[] = [];
  if (from.density !== to.density) out.push(`spacing to ${DENSITY_TEXT[to.density].toLowerCase()}`);
  if (from.margins !== to.margins) out.push(`margins to ${MARGINS_TEXT[to.margins].toLowerCase()}`);
  if (from.size !== to.size) out.push(`text size to ${SIZE_TEXT[to.size].toLowerCase()}`);
  return out;
}

/**
 * Picks the first style (the current one, then each fitSteps step) that measures at most `target` pages.
 * `measured[i]` is the page count of candidate i, where candidate 0 is `style` and the rest are fitSteps(style).
 * When nothing fits, the tightest step is kept and `fits` is false.
 */
export function pickFit(style: ResumeStyle, target: number, measured: readonly number[]): FitResult {
  const cands = [style, ...fitSteps(style)];
  const n = Math.min(cands.length, measured.length);
  for (let i = 0; i < n; i++) {
    if (measured[i]! <= target) return { style: cands[i]!, pages: measured[i]!, fits: true, changes: fitChanges(style, cands[i]!) };
  }
  const last = Math.max(0, n - 1);
  return { style: cands[last]!, pages: measured[last] ?? 1, fits: false, changes: fitChanges(style, cands[last]!) };
}

/** pickFit with a synchronous measure (tests, and any caller that can measure a style on the spot). Stops at the first fit. */
export function fitToPages(style: ResumeStyle, target: number, pagesOf: (s: ResumeStyle) => number): FitResult {
  const measured: number[] = [];
  for (const c of [style, ...fitSteps(style)]) {
    measured.push(pagesOf(c));
    if (measured.at(-1)! <= target) break;
  }
  return pickFit(style, target, measured);
}
