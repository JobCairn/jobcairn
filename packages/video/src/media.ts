import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "@careeros/core";
import { jobBoardBySite, jobBoardByUrl } from "@careeros/contract";
import type { MediaBundle } from "./expander.js";
import { sha256 } from "./hash.js";
import { pictureFor, PACK_CREDITS } from "./packs.js";
import type { Scene, SceneSpec, VideoSubject } from "./types.js";

/**
 * The media stage's pictures: only files that already exist on this computer. Never a download.
 * - The company's logo, when the workspace has one: companies/<slug>/logo.<ext> (or research/ or assets/ inside it).
 * - The job board's mark, from the marks the app bundles (docs/third-party-marks.md), when the job came from one.
 * - Icons and technology logos come from the bundled packs and are drawn inline by the scenes (packs.ts).
 * Every file is checked before it's used: inside the workspace, a real file (no links), a picture type the
 * content agrees with, and at most MAX_PICTURE_BYTES.
 */
export const LOGO_NAMES = ["logo.svg", "logo.png", "logo.jpg", "logo.jpeg", "logo.webp"] as const;
export const LOGO_DIRS = ["", "research", "assets"] as const;
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

export interface GatherInput {
  root: string;
  /** The video folder, relative to the root. */
  folder: string;
  subject: VideoSubject;
  /** plugin/templates/video: the bundled board marks are looked for from here (dev checkout and packaged app). */
  templatesDir: string;
  spec: SceneSpec;
  /** Extra folders holding bundled board marks named <board-id>.svg or .png. */
  markDirs?: string[];
}
export interface Credit { what: string; source: string; license: string; note?: string }
export interface Gathered { bundle: MediaBundle; credits: Credit[]; summary: string; key: string }

/** The picture type a file's first bytes say it is, or null. An SVG must not carry script. */
export function sniffPicture(buf: Buffer, ext: string): string | null {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "png" && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if ((e === "jpg" || e === "jpeg") && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (e === "webp" && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (e === "svg") {
    const head = buf.subarray(0, 4096).toString("utf8");
    const all = buf.toString("utf8");
    if (!/<svg[\s>]/i.test(head) || /<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY/i.test(all)) return null;
    return "svg";
  }
  return null;
}

/** A plain regular file inside the root, of an allowed picture type and size. Null otherwise (never throws). */
export function safePicture(root: string, abs: string): { abs: string; type: string; bytes: Buffer } | null {
  try {
    if (!insideRoot(root, abs)) return null;
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > MAX_PICTURE_BYTES) return null;
    const bytes = fs.readFileSync(abs);
    const type = sniffPicture(bytes, path.extname(abs));
    return type ? { abs, type, bytes } : null;
  } catch { return null; }
}

function companySlug(s: VideoSubject): string | null {
  return "company_slug" in s && typeof s.company_slug === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.company_slug) ? s.company_slug : null;
}

function companyName(root: string, slug: string): string {
  try {
    const f = path.join(root, "companies", slug, "company.json");
    if (!insideRoot(root, f) || !fs.lstatSync(f).isFile() || fs.lstatSync(f).size > 256 * 1024) return slug;
    const v = JSON.parse(fs.readFileSync(f, "utf8")) as { name?: unknown };
    return typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 60) : slug;
  } catch { return slug; }
}

/** The job's board from its record: `source_site`, else the ad's address. Null for a pasted ad or no record. */
function jobBoard(root: string, s: VideoSubject): { id: string; name: string } | null {
  if (s.kind !== "job") return null;
  const slug = companySlug(s);
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s.id)) return null;
  try {
    const f = path.join(root, "companies", slug, "jobs", s.id, "job.json");
    if (!insideRoot(root, f)) return null;
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    const job = JSON.parse(fs.readFileSync(f, "utf8")) as { source_site?: unknown; url?: unknown };
    const b = (typeof job.source_site === "string" && job.source_site.trim() ? jobBoardBySite(job.source_site) : undefined)
      ?? (typeof job.url === "string" && job.url ? jobBoardByUrl(job.url) : undefined);
    return b && b.id !== "pasted" && b.id !== "company-website" ? { id: b.id, name: b.name } : null;
  } catch { return null; }
}

/** Where the bundled board marks live: the brand package (SVG) and docs/assets (PNG), from the repo root. */
export function defaultMarkDirs(templatesDir: string): string[] {
  const repo = path.resolve(templatesDir, "..", "..", "..");
  return [path.join(repo, "packages", "brand", "assets", "boards"), path.join(repo, "docs", "assets", "boards")];
}

/** Technology logos the spec's scenes will show (for the credits). */
export function logosShown(spec: SceneSpec): string[] {
  const out = new Set<string>();
  const add = (label: string, p: { icon?: string; logo?: string; kind?: string } = {}) => {
    const pic = pictureFor(label, p);
    if (pic.kind === "logo") out.add(`${pic.logo.title} (${pic.logo.license})`);
  };
  for (const s of spec.scenes as Scene[]) {
    if (s.type === "icon-grid") s.items.forEach((it) => add(it.label, it));
    if (s.type === "logo-row") s.items.forEach((it) => add(it.name));
    if (s.type === "diagram") s.nodes.forEach((n) => add(n.label, { icon: n.icon, logo: n.logo }));
    if (s.type === "match") s.rows.forEach((r) => add(r.ask, r));
    if (s.type === "timeline") s.steps.forEach((st) => add(st.label, st));
  }
  return [...out].sort();
}

export function gatherMedia(i: GatherInput): Gathered {
  const files: MediaBundle["files"] = [];
  const refs: MediaBundle["refs"] = {};
  const credits: Credit[] = [];
  const said: string[] = [];
  const slug = companySlug(i.subject);
  if (slug) {
    for (const dir of LOGO_DIRS) {
      const hit = LOGO_NAMES.map((n) => safePicture(i.root, path.join(i.root, "companies", slug, dir, n))).find(Boolean);
      if (hit) {
        const rel = `assets/company-logo.${hit.type}`;
        files.push({ abs: hit.abs, rel });
        refs.logo = { src: rel, company: companyName(i.root, slug) };
        credits.push({ what: "Company logo", source: `your workspace (companies/${slug}/${dir ? `${dir}/` : ""}${path.basename(hit.abs)})`, license: "belongs to the company; shown to name it" });
        said.push("the company logo");
        break;
      }
    }
  }
  const board = jobBoard(i.root, i.subject);
  if (board) {
    const dirs = [...(i.markDirs ?? []), ...defaultMarkDirs(i.templatesDir)];
    let src: string | undefined;
    for (const d of dirs) {
      for (const ext of ["svg", "png"]) {
        const abs = path.join(d, `${board.id}.${ext}`);
        let ok = false;
        try { const st = fs.lstatSync(abs); ok = st.isFile() && st.size > 0 && st.size <= MAX_PICTURE_BYTES && !!sniffPicture(fs.readFileSync(abs), ext); } catch { ok = false; }
        if (ok) { src = `assets/board-${board.id}.${ext}`; files.push({ abs, rel: src }); break; }
      }
      if (src) break;
    }
    refs.board = { ...(src ? { src } : {}), name: board.name };
    if (src) credits.push({ what: `${board.name} mark`, source: "bundled with the app (docs/third-party-marks.md)", license: "belongs to its owner; shown to say where the ad came from" });
    said.push(src ? `the ${board.name} mark` : `${board.name} (no mark, so its initials)`);
  }
  const logos = logosShown(i.spec);
  for (const pc of PACK_CREDITS) credits.push({ what: pc.pack, source: pc.source, license: pc.license, ...(pc.note ? { note: pc.note } : {}) });
  if (logos.length) credits.push({ what: "Technology logos shown", source: logos.join(", "), license: "see each" });
  const key = sha256("media", JSON.stringify(refs), ...files.map((f) => sha256(f.rel, fs.readFileSync(f.abs))));
  const summary = said.length ? `Using ${said.join(" and ")}` : "No company logo in your files, so the video uses icons";
  return { bundle: { refs, files }, credits, summary, key };
}

/** The credits as Markdown, for credits.md and the "Credits" section of notes.md. */
export function creditsMarkdown(credits: Credit[], extra: string[] = []): string {
  return [
    ...credits.map((c) => `- ${c.what}: ${c.source}. Licence: ${c.license}.${c.note ? ` ${c.note}` : ""}`),
    ...extra.map((x) => `- ${x}`),
  ].join("\n");
}

const START = "<!-- jobcairn:credits -->";
const END = "<!-- /jobcairn:credits -->";
/** notes.md with its Credits section added or replaced (between markers, so a rerun never repeats it). */
export function withCredits(notes: string, md: string): string {
  const block = `${START}\n## Credits\n\n${md}\n${END}`;
  const a = notes.indexOf(START), b = notes.indexOf(END);
  if (a >= 0 && b > a) return `${notes.slice(0, a)}${block}${notes.slice(b + END.length)}`;
  return `${notes.replace(/\s*$/, "")}\n\n${block}\n`;
}
