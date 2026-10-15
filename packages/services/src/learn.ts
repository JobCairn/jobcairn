import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout } from "@careeros/core";
import { fileKind, type LearnData, type LearnItem } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { lockedFor } from "./integrity.js";
import { jobDirRel, jobRows } from "./read.js";

const HEAD_BYTES = 4096;

/** True when `dir` is a real (not linked) folder inside the workspace and not in a locked area. */
function safeDir(ctx: ServiceContext, root: string, dir: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return false; }
  if (st.isSymbolicLink() || !st.isDirectory() || !insideRoot(root, dir)) return false;
  return lockedFor(ctx, root, dir) === null;
}

function realDirs(ctx: ServiceContext, root: string, dir: string): string[] {
  if (!safeDir(ctx, root, dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).filter((n) => {
    const st = fs.lstatSync(path.join(dir, n));
    return st.isDirectory() && !st.isSymbolicLink();
  }).sort();
}

function titleOf(file: string, fallback: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8").match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
  } finally { fs.closeSync(fd); }
}

/**
 * Guides (.md) and videos in one folder, as workspace-relative items. Links and hidden files are skipped, and so is
 * the copy a web re-run sets aside (guide.previous.md) while Claude writes a new guide.
 */
function items(ctx: ServiceContext, root: string, rel: string): LearnItem[] {
  const dir = path.join(root, rel);
  if (!safeDir(ctx, root, dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith(".") && !/\.previous\.[^.]+$/.test(n)).sort().flatMap((n): LearnItem[] => {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    if (!st.isFile()) return [];
    const kind = fileKind(n);
    if (kind === "markdown") return [{ path: `${rel}/${n}`, title: titleOf(p, n), kind: "guide" }];
    if (kind === "video") return [{ path: `${rel}/${n}`, title: n, kind: "video" }];
    return [];
  });
}

/** At most this many subfolders are looked at in any one folder, so a huge folder can't stall Learn. */
const MAX_VIDEO_DIRS = 120;
const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * The video a folder holds: <rel>/renders/final.mp4, else renders/draft.mp4 (the video skills make the final cut
 * only after the person approves the draft). Linked folders and render files that aren't regular files are skipped.
 */
function rendered(ctx: ServiceContext, root: string, rel: string, title: string): LearnItem[] {
  const renders = path.join(root, rel, "renders");
  if (!safeDir(ctx, root, path.join(root, rel)) || !safeDir(ctx, root, renders)) return [];
  for (const name of ["final.mp4", "draft.mp4"]) {
    try {
      if (fs.lstatSync(path.join(renders, name)).isFile()) {
        return [{ path: `${rel}/renders/${name}`, title: name === "draft.mp4" ? `${title} (draft)` : title, kind: "video" }];
      }
    } catch { /* not rendered */ }
  }
  return [];
}

/** Videos one folder down from `rel`, one per subfolder whose name `title` accepts (null skips it). Never walks deeper. */
function videosIn(ctx: ServiceContext, root: string, rel: string, title: (name: string) => string | null, order = byNumber): LearnItem[] {
  return realDirs(ctx, root, path.join(root, rel)).sort(order).slice(0, MAX_VIDEO_DIRS).flatMap((n) => {
    const t = title(n);
    return t === null ? [] : rendered(ctx, root, `${rel}/${n}`, t);
  });
}

const numbered = (prefix: string, label: string) => (name: string) => {
  const m = new RegExp(`^${prefix}([1-9][0-9]?)$`).exec(name);
  return m ? `${label} ${m[1]}` : null;
};

/** The job's interview drills and pitches (interview/<n>, interview/pitch-<n>, other video folders there too). */
function interviewTitle(name: string): string | null {
  if (name === "renders") return null;
  return numbered("", "Interview drill")(name) ?? numbered("pitch-", "Pitch")(name) ?? `Video: ${name.replace(/-/g, " ")}`;
}

/** Every learning topic, job-linked prep item and recap in the workspace. */
export function learnList(ctx: ServiceContext): LearnData {
  const root = ctx.requireRoot();
  const topics = realDirs(ctx, root, layout(root).learning).map((slug) => {
    const its = [...items(ctx, root, `learning/${slug}`), ...videosIn(ctx, root, `learning/${slug}/videos`, numbered("", "Video lesson"))];
    return { slug, title: its.find((i) => i.kind === "guide")?.title ?? slug, items: its };
  });
  const interviewPrep = jobRows(root).flatMap((r) => {
    const job = jobDirRel(r.company_slug, r.id);
    const its = [
      ...items(ctx, root, `${job}/interview`),
      ...videosIn(ctx, root, `${job}/interview`, interviewTitle),
      ...videosIn(ctx, root, `${job}/videos`, numbered("jd-walkthrough-", "JD walkthrough")),
      ...rendered(ctx, root, `${job}/application/summary-video`, "Application summary"),
      ...videosIn(ctx, root, `companies/${r.company_slug}/videos`, numbered("briefing-", "Company briefing")),
    ];
    return its.length ? [{ company_slug: r.company_slug, id: r.id, title: r.title, company_name: r.company_name, items: its }] : [];
  }).sort((a, b) => a.company_name.localeCompare(b.company_name) || a.title.localeCompare(b.title));
  const recaps = videosIn(ctx, root, "recaps", (n) => (/^\d{4}-W\d{2}$/.test(n) ? `Weekly recap ${n}` : null), (a, b) => b.localeCompare(a));
  // video.ts's learn.list (registered after this one) fills videos and video_recaps from the video.json records.
  return { topics, interviewPrep, recaps, videos: [], video_recaps: [] };
}

export const learnHandlers = { "learn.list": learnList } satisfies Partial<HandlerTable>;
