import { describe, expect, it } from "vitest";
import {
  addRole, addRoleBullet, moveEntry, removeEntry, addSectionEntry, addTypedSection, DEFAULT_RESUME_STYLE, entryView, fitSteps, fitToPages, formatDates, headerView, itemView,
  parseDates, parseResume, parseResumeStyle, pickFit, resumeLayout, resumeStyleArg, rewriteOptionsFor, SECTION_TYPES, SECTION_INFO, sectionType, sectionView,
  serializeResume, setEntryFields, setHeader, setItem, setRole, setSkillGroup, withTemplate, type ResumeEntry, type ResumeModel, type SectionItem, type SectionType,
} from "../src/index.js";

// Fictional data only. Email and phone are built by concatenation so the privacy scan stays meaningful.
const EMAIL = "alex" + "@" + "example.com";
const PHONE = "0491 570" + " 006";

const ALEX = [
  "# Alex Example", "",
  `AI Engineer · Sampletown NSW 2000 · ${EMAIL} · ${PHONE}`, "",
  "## Summary", "",
  "AI engineer who builds **retrieval** pipelines and LLM agents for support teams (fictional).", "",
  "## Experience", "",
  "### AI Engineer, Example Labs",
  "*2024 to now · Sampletown*", "",
  "- Built a retrieval pipeline that answers support questions from product docs.",
  "- Added an evaluation suite that checks answers against cited sources.", "",
  "### Software Developer, Acme Corp",
  "*2021 to 2024 · Sampletown*", "",
  "- Wrote Node.js services for the billing team.", "",
  "## Skills", "",
  "- Python, TypeScript, Node.js",
  "- **Cloud:** AWS, Docker", "",
  "## Education", "",
  "### BSc Computer Science, Example University",
  "*2017 to 2020*", "",
].join("\n");

const PIPES = [
  "# Alex Example", "",
  "AI Engineer | Retrieval and agents", "",
  `${EMAIL} | ${PHONE} | linkedin.com/in/alex-example | Sampletown, NSW, Australia`, "",
  "Open to hybrid work in Sampletown.", "",
  "## Experience", "",
  "### Example Labs Pty Ltd, Sydney | Aug 2023 to Present", "",
  "AI Engineer, Oct 2025 to Present. Software Developer, Aug 2023 to Oct 2025.", "",
  "- Built an evaluation harness for retrieval answers.", "",
  "### Acme Corp | Apr 2022 to Jun 2023", "",
  "- Wrote reporting services.", "",
  "## Education", "",
  "- Master of Data Science | Example University | 2020 to 2022",
  "- BSc Computer Science | Example Institute | 2016 to 2019", "",
  "## Certifications", "",
  "- AWS Certified Developer | Amazon Web Services | 2024", "",
  "## Languages", "",
  "- English: Native",
  "- Nepali: Fluent", "",
].join("\n");

const MULTI = [
  "# Alex Example", "",
  "## Experience", "",
  "### Example Labs | Jan 2021 to Present",
  "**Senior AI Engineer** · Jan 2024 to Present",
  "- Led the retrieval platform.", "",
  "**AI Engineer** | Jan 2021 to Dec 2023", "",
  "- Built the first agent.", "",
].join("\n");

type ListItem = Extract<SectionItem, { kind: "list" }>;
const lineDiff = (a: string, b: string) => { const x = a.split("\n"), y = b.split("\n"); return x.map((l, i) => (l === y[i] ? null : [l, y[i]])).filter(Boolean); };
const entries = (m: ResumeModel, i: number) => sectionView(m.sections[i]!).items.filter((x) => x.kind === "entry").map((x) => (x as { entry: ReturnType<typeof entryView> }).entry);
const reparse = (m: ResumeModel) => parseResume(serializeResume(m));

describe("untouched files", () => {
  it.each([["alex", ALEX], ["pipes", PIPES], ["multi", MULTI]])("%s round-trips byte for byte", (_n, md) => {
    expect(serializeResume(parseResume(md))).toBe(md);
    // Reading the structured view never changes the file.
    const m = parseResume(md);
    headerView(m); m.sections.forEach((s) => sectionView(s)); resumeLayout(m);
    expect(serializeResume(m)).toBe(md);
  });
});

describe("dates", () => {
  it("parses ranges in the format they were written and writes them back the same way", () => {
    for (const t of ["2024 to now", "Aug 2023 to Present", "Jan 2024 – Present", "2017 - 2020", "03/2021 to 05/2022", "September 2019 to June 2020", "2024"]) {
      const p = parseDates(t);
      expect(p, t).not.toBeNull();
      expect(formatDates(p!.range, p!.format)).toBe(t);
    }
    expect(parseDates("Sampletown")).toBeNull();
    expect(parseDates("13/2020")).toBeNull();
    expect(formatDates({ start: { year: 2022, month: 3 }, end: "present" })).toBe("Mar 2022 to Present");
  });
});

describe("header fields", () => {
  it("reads typed fields from one combined line and from separate lines", () => {
    expect(headerView(parseResume(ALEX))).toMatchObject({ name: "Alex Example", headline: "AI Engineer", location: "Sampletown NSW 2000", email: EMAIL, phone: PHONE, links: [] });
    const p = headerView(parseResume(PIPES));
    expect(p).toMatchObject({ headline: "AI Engineer | Retrieval and agents", email: EMAIL, phone: PHONE, links: ["linkedin.com/in/alex-example"], location: "Sampletown, NSW, Australia" });
    expect(p.rest).toHaveLength(1);
  });

  it("changes only the edited piece of text", () => {
    const m = parseResume(ALEX);
    const out = serializeResume(setHeader(m, { email: "alex.e" + "@" + "example.com" }));
    expect(lineDiff(ALEX, out)).toEqual([[`AI Engineer · Sampletown NSW 2000 · ${EMAIL} · ${PHONE}`, `AI Engineer · Sampletown NSW 2000 · alex.e${"@"}example.com · ${PHONE}`]]);
    const p = serializeResume(setHeader(parseResume(PIPES), { headline: "Applied AI Engineer" }));
    expect(lineDiff(PIPES, p)).toEqual([["AI Engineer | Retrieval and agents", "Applied AI Engineer"]]);
  });

  it("adds, removes and lists links as chips, and parses back to the same fields", () => {
    let m = parseResume(ALEX);
    m = setHeader(m, { links: ["github.com/alex-example", "[Portfolio](https://example.com/alex)"] });
    m = setHeader(m, { phone: "" });
    const v = headerView(reparse(m));
    expect(v.links).toEqual(["github.com/alex-example", "[Portfolio](https://example.com/alex)"]);
    expect(v.phone).toBe("");
    expect(v.email).toBe(EMAIL);
    expect(serializeResume(m)).toContain(`AI Engineer · Sampletown NSW 2000 · ${EMAIL} · github.com/alex-example · [Portfolio](https://example.com/alex)`);
    m = setHeader(m, { links: ["[Portfolio](https://example.com/alex)"] });
    expect(headerView(reparse(m)).links).toEqual(["[Portfolio](https://example.com/alex)"]);
  });

  it("adds missing fields to a header that has none", () => {
    const m = setHeader(parseResume("# Alex Example\n\n## Summary\n\nHello.\n"), { headline: "AI Engineer", email: EMAIL, phone: PHONE, location: "Sampletown NSW 2000" });
    const v = headerView(reparse(m));
    expect(v).toMatchObject({ headline: "AI Engineer", email: EMAIL, phone: PHONE, location: "Sampletown NSW 2000" });
    expect(reparse(m).sections[0]!.heading).toBe("Summary");
  });
});

describe("entries", () => {
  it("reads organisation, role, place and dates in several shapes", () => {
    const [a, b] = entries(parseResume(ALEX), 1);
    expect(a).toMatchObject({ role: "AI Engineer", org: "Example Labs", dates: "2024 to now", location: "Sampletown" });
    expect(b).toMatchObject({ role: "Software Developer", org: "Acme Corp", dates: "2021 to 2024" });
    expect(entries(parseResume(ALEX), 3)[0]).toMatchObject({ role: "BSc Computer Science", org: "Example University", dates: "2017 to 2020" });
    const [p] = entries(parseResume(PIPES), 0);
    expect(p).toMatchObject({ org: "Example Labs Pty Ltd", location: "Sydney", dates: "Aug 2023 to Present" });
  });

  it("edits a field in place, changing one line", () => {
    const m = parseResume(ALEX);
    const id = entries(m, 1)[0]!.id;
    const out = setEntryFields(m, id, "experience", { dates: "Jan 2024 to Present" });
    expect(lineDiff(ALEX, serializeResume(out))).toEqual([["*2024 to now · Sampletown*", "*Jan 2024 to Present · Sampletown*"]]);
    const org = setEntryFields(m, id, "experience", { org: "Example Labs Pty Ltd" });
    expect(lineDiff(ALEX, serializeResume(org))).toEqual([["### AI Engineer, Example Labs", "### AI Engineer, Example Labs Pty Ltd"]]);
    expect(entries(reparse(org), 1)[0]).toMatchObject({ role: "AI Engineer", org: "Example Labs Pty Ltd", location: "Sampletown" });
  });

  it("adds a field the entry didn't have, and it parses back", () => {
    const m = parseResume(PIPES);
    const id = entries(m, 0)[1]!.id;
    const out = setEntryFields(m, id, "experience", { role: "Software Developer", location: "Sampletown" });
    expect(entries(reparse(out), 0)[1]).toMatchObject({ org: "Acme Corp", role: "Software Developer", location: "Sampletown", dates: "Apr 2022 to Jun 2023" });
    // Its bullets stay.
    expect(serializeResume(out)).toContain("- Wrote reporting services.");
  });

  it("an entry with a blank line before its bullets still owns them, with the line between as a note", () => {
    const m = parseResume(PIPES);
    const [e, acme] = entries(m, 0);
    expect(e!.notes.map((n) => n.text)).toEqual(["AI Engineer, Oct 2025 to Present. Software Developer, Aug 2023 to Oct 2025."]);
    expect(e!.bullets.map((b) => b.text)).toEqual(["Built an evaluation harness for retrieval answers."]);
    expect(acme!.bullets.map((b) => b.text)).toEqual(["Wrote reporting services."]);
    expect(sectionView(m.sections[0]!).items.every((x) => x.kind === "entry")).toBe(true);
    const d = resumeLayout(m).sections[0]!.items[0]!;
    expect(d).toMatchObject({ t: "entry", title: "Example Labs Pty Ltd", sub: "Sydney", extra: ["AI Engineer, Oct 2025 to Present. Software Developer, Aug 2023 to Oct 2025."] });
    // Moving or deleting the entry takes its note and bullets with it.
    const moved = serializeResume(moveEntry(m, m.sections[0]!.id, e!.id, 1));
    expect(moved.indexOf("### Acme Corp")).toBeLessThan(moved.indexOf("### Example Labs"));
    expect(moved.indexOf("Built an evaluation harness")).toBeGreaterThan(moved.indexOf("### Example Labs"));
    expect(serializeResume(removeEntry(m, m.sections[0]!.id, e!.id))).not.toMatch(/Example Labs|evaluation harness|Oct 2025/);
  });

  it("keeps several roles at one organisation, and adds one", () => {
    const m = parseResume(MULTI);
    const [e] = entries(m, 0);
    expect(e!.org).toBe("Example Labs");
    expect(e!.roles.map((r) => [r.title, r.bullets.length])).toEqual([["Senior AI Engineer", 1], ["AI Engineer", 1]]);
    expect(e!.roleDates).toBe("Jan 2024 to Present");
    const added = addRole(m, m.sections[0]!.id, e!.id);
    let n = setRole(added.model, added.focusId, { title: "Graduate Engineer", dates: "Jan 2020 to Dec 2020" });
    const role = entries(n, 0)[0]!.roles[2]!;
    n = addRoleBullet(n, role, "Wrote tests for the data pipeline.").model;
    const back = entries(reparse(n), 0)[0]!;
    expect(back.roles.map((r) => [r.title, r.dates, r.bullets.map((b) => b.text)])).toEqual([
      ["Senior AI Engineer", "Jan 2024 to Present", ["Led the retrieval platform."]],
      ["AI Engineer", "Jan 2021 to Dec 2023", ["Built the first agent."]],
      ["Graduate Engineer", "Jan 2020 to Dec 2020", ["Wrote tests for the data pipeline."]],
    ]);
  });
});

describe("items and chips", () => {
  it("reads one-line items by section type and edits one piece", () => {
    const m = parseResume(PIPES);
    const edu = sectionView(m.sections[1]!);
    expect(edu.type).toBe("education");
    const list = edu.items.find((x) => x.kind === "list")!;
    const first = (list as { block: { bullets: { id: string; text: string }[] } }).block.bullets[0]!;
    expect(itemView(first as never, "education")).toMatchObject({ fields: ["Master of Data Science", "Example University"], dates: "2020 to 2022" });
    const out = setItem(m, first.id, "education", { dates: "2020 to 2021" });
    expect(lineDiff(PIPES, serializeResume(out))).toEqual([["- Master of Data Science | Example University | 2020 to 2022", "- Master of Data Science | Example University | 2020 to 2021"]]);
    const lang = sectionView(m.sections[3]!);
    const en = (lang.items[0] as ListItem).block.bullets[0]!;
    expect(itemView(en, "languages").fields).toEqual(["English", "Native"]);
    const fixed = setItem(m, (en as { id: string }).id, "languages", { fields: ["English", "Native speaker"] });
    expect(serializeResume(fixed)).toContain("- English: Native speaker\n");
  });

  it("reads skill groups as chips and writes them back in the same style", () => {
    const m = parseResume(ALEX);
    const s = sectionView(m.sections[2]!);
    expect(s.groups.map((g) => [g.label, g.chips])).toEqual([["", ["Python", "TypeScript", "Node.js"]], ["Cloud", ["AWS", "Docker"]]]);
    let out = setSkillGroup(m, s.groups[1]!.id, { chips: ["AWS", "Docker", "Terraform"] });
    expect(lineDiff(ALEX, serializeResume(out))).toEqual([["- **Cloud:** AWS, Docker", "- **Cloud:** AWS, Docker, Terraform"]]);
    out = setSkillGroup(out, s.groups[0]!.id, { label: "Languages" });
    expect(sectionView(reparse(out).sections[2]!).groups[0]).toMatchObject({ label: "Languages", chips: ["Python", "TypeScript", "Node.js"] });
  });
});

describe("every section type", () => {
  // Fill a new section of each type through its own setters, save, and read it back.
  it.each(SECTION_TYPES.map((t) => [t]))("%s round-trips through Markdown", (type: SectionType) => {
    const added = addTypedSection(parseResume(ALEX), type);
    let m = added.model;
    const info = SECTION_INFO[type];
    const sec = () => m.sections.find((s) => s.id === added.sectionId)!;
    if (info.shape === "entries") {
      m = setEntryFields(m, added.focusId, type, { org: "Example Labs", role: "Volunteer lead", location: "Sampletown", dates: "Jan 2022 to Present" });
      m = addRoleBullet(m, { id: added.focusId, listId: added.focusId }, "Ran a weekly coding club.").model;
    } else if (info.shape === "items") {
      m = setItem(m, added.focusId, type, { fields: info.itemFields.map((f, i) => (i === 0 ? "First thing" : "Second thing")), dates: type === "languages" ? "" : "2023" });
    } else if (info.shape === "chips") {
      m = setSkillGroup(m, added.focusId, { label: "Tools", chips: ["Python", "Docker"] });
    } else {
      const b = sec().blocks[0]!;
      (b as { text: string }).text = "A short paragraph.";
    }
    const back = reparse(m);
    const s = back.sections.at(-1)!;
    expect(sectionType(s.heading)).toBe(type);
    const v = sectionView(s);
    expect(v.shape).toBe(info.shape);
    if (info.shape === "entries") expect(v.items[0]).toMatchObject({ kind: "entry", entry: { org: "Example Labs", role: "Volunteer lead", location: "Sampletown", dates: "Jan 2022 to Present" } });
    if (info.shape === "entries") expect((v.items[0] as { entry: { bullets: { text: string }[] } }).entry.bullets.map((b) => b.text)).toEqual(["Ran a weekly coding club."]);
    if (info.shape === "items") {
      const b = (v.items[0] as ListItem).block.bullets[0]!;
      expect(itemView(b, type).fields).toEqual(info.itemFields.map((_f, i) => (i === 0 ? "First thing" : "Second thing")));
    }
    if (info.shape === "chips") expect(v.groups[0]).toMatchObject({ label: "Tools", chips: ["Python", "Docker"] });
    if (info.shape === "text") expect(v.items[0]).toMatchObject({ kind: "text" });
    // The sections before it are untouched.
    expect(serializeResume(back).startsWith(ALEX)).toBe(true);
  });

  it("Add entry adds the right kind of thing", () => {
    const m = parseResume(PIPES);
    const certs = m.sections[2]!;
    const r = addSectionEntry(m, certs.id);
    expect(sectionView(r.model.sections[2]!).items[0]).toMatchObject({ kind: "list" });
    expect((r.model.sections[2]!.blocks[0] as { bullets: unknown[] }).bullets).toHaveLength(2);
    const e = addSectionEntry(m, m.sections[0]!.id);
    expect((e.model.sections[0]!.blocks.at(-1) as ResumeEntry).kind).toBe("entry");
  });

  it("per-bullet AI positions still match the saved file after structured edits", () => {
    let m = parseResume(MULTI);
    const e = entries(m, 0)[0]!;
    m = addRoleBullet(m, e.roles[1]!, "Another bullet.").model;
    const bullet = entries(m, 0)[0]!.roles[1]!.bullets[1]!;
    expect(rewriteOptionsFor(m, bullet.id)).toEqual({ scope: "bullet", section_id: "s0", bullet_id: "b2" });
    const saved = reparse(m);
    expect(entries(saved, 0)[0]!.roles[1]!.bullets[1]!.text).toBe("Another bullet.");
  });
});

describe("layout tree", () => {
  it("lays out one role per entry with dates, items and chip groups", () => {
    const d = resumeLayout(parseResume(ALEX));
    expect(d.name?.text).toBe("Alex Example");
    expect(d.headline?.text).toBe("AI Engineer");
    expect(d.contact.map((c) => c.text)).toEqual(["Sampletown NSW 2000", EMAIL, PHONE]);
    const exp = d.sections[1]!.items[0]!;
    expect(exp).toMatchObject({ t: "entry", title: "AI Engineer", sub: "Example Labs · Sampletown", dates: "2024 to now" });
    expect(d.sections[2]!.items[0]).toMatchObject({ t: "groups" });
    const p = resumeLayout(parseResume(PIPES));
    expect(p.sections[1]!.items[0]).toMatchObject({ t: "items", items: [{ main: "Master of Data Science", sub: "Example University", dates: "2020 to 2022" }, expect.anything()] });
    expect(p.contact.find((c) => c.text.startsWith("linkedin"))?.href).toBe("https://linkedin.com/in/alex-example");
  });

  it("lays out several roles under one organisation and leaves hidden sections out", () => {
    const d = resumeLayout(parseResume(MULTI));
    expect(d.sections[0]!.items[0]).toMatchObject({ t: "entry", title: "Example Labs", dates: "Jan 2021 to Present", roles: [{ title: "Senior AI Engineer", dates: "Jan 2024 to Present" }, { title: "AI Engineer", dates: "Jan 2021 to Dec 2023" }] });
    expect(resumeLayout(parseResume(ALEX), ["skills"]).sections.map((s) => s.heading)).toEqual(["Summary", "Experience", "Education"]);
  });
});

describe("styles", () => {
  it("reads older style files and drops monospace", () => {
    const s = parseResumeStyle({ layout: "minimal", font: "mono", accent: "navy", density: "tight", page: "letter", hidden: ["skills"] });
    expect(s).toMatchObject({ layout: "minimal", font: "geist", accent: "navy", density: "tight", page: "letter", headings: "caps", dates: "inline", margins: "wide" });
    expect(parseResumeStyle({ layout: "nope", margins: "huge" })).toEqual(DEFAULT_RESUME_STYLE);
    expect(resumeStyleArg(DEFAULT_RESUME_STYLE, "style")).toEqual(DEFAULT_RESUME_STYLE);
    expect(() => resumeStyleArg({ ...DEFAULT_RESUME_STYLE, css: "x" }, "style")).toThrow();
  });

  it("applies a template's preset and keeps the accent, page and hidden sections", () => {
    const s = withTemplate({ ...DEFAULT_RESUME_STYLE, accent: "teal", page: "letter", hidden: ["skills"] }, "executive");
    expect(s).toMatchObject({ layout: "executive", font: "serif-text", density: "relaxed", margins: "wide", accent: "teal", page: "letter", hidden: ["skills"] });
  });
});

describe("fit to pages", () => {
  it("tries density, then margins, then text size", () => {
    const steps = fitSteps({ ...DEFAULT_RESUME_STYLE, density: "relaxed", margins: "wide" });
    expect(steps.map((s) => `${s.density}/${s.margins}/${s.size}`)).toEqual([
      "standard/wide/normal", "tight/wide/normal", "tight/normal/normal", "tight/narrow/normal", "tight/narrow/small", "tight/narrow/smaller",
    ]);
  });

  it("stops at the first style that fits and says what changed", () => {
    // Pretend each step saves a third of a page from 2.6 pages.
    const pages = (s: typeof DEFAULT_RESUME_STYLE) => {
      let h = 2.6;
      if (s.density === "tight") h -= 0.35;
      if (s.margins === "narrow") h -= 0.35;
      return Math.ceil(h);
    };
    const r = fitToPages(DEFAULT_RESUME_STYLE, 2, pages);
    expect(r).toMatchObject({ fits: true, pages: 2, changes: ["spacing to tight", "margins to narrow"] });
    expect(fitToPages(DEFAULT_RESUME_STYLE, 3, pages)).toMatchObject({ fits: true, changes: [] });
    const none = fitToPages(DEFAULT_RESUME_STYLE, 1, pages);
    expect(none).toMatchObject({ fits: false, changes: ["spacing to tight", "margins to narrow", "text size to smaller"] });
    expect(pickFit(DEFAULT_RESUME_STYLE, 1, [3, 2, 1])).toMatchObject({ fits: true, pages: 1, changes: ["spacing to tight", "margins to narrow"] });
  });
});
