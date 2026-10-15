import fs from "node:fs";
import os from "node:os";
import { ArgError } from "@careeros/contract";
import identity from "@careeros/brand/identity.json" with { type: "json" };

// ---- error sanitising -------------------------------------------------------

const FS_MESSAGES: Record<string, (name: string) => string> = {
  ENOENT: (n) => `"${n}" wasn't found.`,
  EACCES: (n) => `${identity.name} isn't allowed to use "${n}".`,
  EPERM: (n) => `${identity.name} isn't allowed to use "${n}".`,
  EEXIST: (n) => `"${n}" already exists.`,
  ENOTDIR: (n) => `"${n}" isn't a folder.`,
  EISDIR: (n) => `"${n}" is a folder, not a file.`,
  ENOTEMPTY: (n) => `"${n}" isn't empty.`,
  ENOSPC: () => "The disk is full.",
  EMFILE: () => "Too many files are open. Try again in a moment.",
  EBUSY: (n) => `"${n}" is busy. Try again in a moment.`,
};

const baseOf = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
const short = (p: string) => { const b = baseOf(p); return b ? `…/${b}` : "…"; };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const variants = (p: string): string[] => {
  const out = new Set([p]);
  try { out.add(fs.realpathSync.native(p)); } catch { /* gone */ }
  if (p.startsWith("/private/")) out.add(p.slice("/private".length));
  return [...out].filter((x) => x.length > 1);
};
// A path rooted at "/", a drive letter or a UNC share, starting a word (so "acme-corp/x" and URLs stay).
// ":" may lead a single "/" ("path:/etc/hosts") but not "//" ("https://...").
const ROOTED = /(^|[\s'"(=[<,`]|:(?=\/(?!\/)))((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"),\]>`]*)/g;
// A rooted path wrapped in matching quotes, which may contain spaces: scrubbed up to the closing quote.
const QUOTED = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^"'`\n]*)\1/g;
const FILE_URL = /file:\/\/[^\s'"`)>\]]*/gi;

function scrub(message: string, roots: string[]): string {
  let out = message;
  const longestFirst = (xs: string[]) => [...new Set(xs)].sort((a, b) => b.length - a.length);
  const rootList = longestFirst(roots.flatMap(variants));
  /** One whole path: relative inside the workspace, "…/name" anywhere else. */
  const scrubPath = (p: string): string => {
    for (const r of rootList) {
      if (p === r) return "the workspace";
      if (p.startsWith(`${r}/`) || p.startsWith(`${r}\\`)) return p.slice(r.length + 1).split("\\").join("/");
    }
    return short(p);
  };
  out = out.replace(FILE_URL, (url) => {
    let p = url.slice("file://".length);
    try { p = decodeURIComponent(p); } catch { /* keep it encoded */ }
    return scrubPath(p);
  });
  out = out.replace(QUOTED, (_m, q: string, p: string) => q + scrubPath(p) + q);
  for (const r of rootList) {
    // Inside the workspace: keep the relative path, which is what the person knows the file by.
    out = out.replace(new RegExp(`${escape(r)}[\\\\/]([^\\s'"),\\]>\`]*)`, "g"), (_m, rest: string) => rest.split("\\").join("/"));
    out = out.split(r).join("the workspace");
  }
  for (const p of longestFirst([...variants(os.tmpdir()), ...variants(os.homedir())])) {
    out = out.replace(new RegExp(`${escape(p)}(?:[\\\\/][^'"),\\]>\`]*?)?(?=$|[\\s'"),\\]>\`])`, "g"), short);
  }
  return out.replace(ROOTED, (_m, lead: string, p: string) => lead + short(p));
}

/**
 * What the renderer sees when a handler fails: a fresh Error with one plain sentence.
 * No stack, no `code`/`path`/`errno` fields, and no absolute path (workspace paths become relative, others "…/name").
 */
export function plainError(err: unknown, roots: string | null | (string | null)[]): Error {
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter((r): r is string => typeof r === "string" && r.length > 1);
  let message: string;
  const e = err as { code?: unknown; path?: unknown; message?: unknown } | null;
  if (e && typeof e === "object" && typeof e.code === "string" && FS_MESSAGES[e.code]) {
    const name = typeof e.path === "string" ? baseOf(e.path) : "";
    message = name || e.code === "ENOSPC" || e.code === "EMFILE" ? FS_MESSAGES[e.code]!(name) : "A file couldn't be used.";
  } else if (err instanceof Error || (e && typeof e === "object" && typeof e.message === "string")) {
    message = String((e as { message: string }).message);
  } else if (typeof err === "string") {
    message = err;
  } else {
    message = "";
  }
  message = scrub(message.split("\n")[0]!.trim(), rootList).slice(0, 500) || "Something went wrong.";
  const out = err instanceof ArgError ? new ArgError(message) : new Error(message);
  out.stack = `${out.name}: ${message}`;
  return out;
}
