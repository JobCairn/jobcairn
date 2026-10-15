import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "@careeros/core";
import { parseLinkedInConnections, peopleAt, type NetworkPerson, type NetworkStatus } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { checkIncomingFile, realDirInRoot } from "./files.js";
import type { HandlerTable } from "./handlers.js";

/**
 * The referral finder's store: me/network/linkedin-connections.json, written only by this module through store.ts
 * (writeFileAtomic, owner-only). The folder carries its own .gitignore ("*"), so the list is never committed, and no
 * Claude action reads it (prompts point only at me/history and me/resumes).
 */
const DIR = "me/network";
const FILE = "linkedin-connections.json";
/** A connections export is a few MB at most; anything bigger isn't one. */
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_STORE_BYTES = 20 * 1024 * 1024;

interface Stored { version: 1; imported_at: string; file: string; people: NetworkPerson[] }
const NONE: NetworkStatus = { count: 0, imported_at: "", file: "" };

const storePath = (root: string) => path.join(root, DIR, FILE);

function readStore(root: string): Stored | null {
  const file = storePath(root);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_STORE_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<Stored>;
    if (v.version !== 1 || !Array.isArray(v.people)) return null;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    const people = v.people.filter((p): p is NetworkPerson => !!p && typeof p === "object").map((p) => ({
      first: str(p.first), last: str(p.last), url: str(p.url), email: str(p.email), company: str(p.company), position: str(p.position),
    }));
    return { version: 1, imported_at: str(v.imported_at), file: str(v.file), people };
  } catch { return null; } finally { fs.closeSync(fd); }
}

const statusOf = (s: Stored | null): NetworkStatus => (s ? { count: s.people.length, imported_at: s.imported_at, file: s.file } : NONE);

function readCsv(abs: string): { name: string; text: string } {
  const f = checkIncomingFile(null, abs);
  if (!/\.csv$/i.test(f.name)) throw new Error(`"${f.name}" isn't a CSV file. Pick Connections.csv from your LinkedIn data export.`);
  if (f.size > MAX_CSV_BYTES) throw new Error(`"${f.name}" is larger than 10 MB, so it isn't a connections export.`);
  const fd = fs.openSync(f.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino || st.size > MAX_CSV_BYTES) throw new Error(`"${f.name}" changed after it was picked. Pick it again.`);
    return { name: f.name, text: fs.readFileSync(fd, "utf8") };
  } finally { fs.closeSync(fd); }
}

export function importLinkedIn(ctx: ServiceContext, abs: string): NetworkStatus {
  const root = ctx.requireRoot();
  const { name, text } = readCsv(abs);
  const people = parseLinkedInConnections(text);
  const dir = realDirInRoot(root, path.join(root, DIR), DIR);
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) writeFileAtomic(ignore, "# Your LinkedIn connections stay on this computer.\n*\n", 0o600);
  const stored: Stored = { version: 1, imported_at: ctx.now().toISOString(), file: name.slice(0, 120), people };
  writeFileAtomic(storePath(root), `${JSON.stringify(stored)}\n`, 0o600);
  return statusOf(stored);
}

export const networkHandlers = {
  "network.status": (ctx: ServiceContext) => statusOf(readStore(ctx.requireRoot())),
  "network.importLinkedIn": importLinkedIn,
  "network.people": (ctx: ServiceContext, company: string) => peopleAt(readStore(ctx.requireRoot())?.people ?? [], [company]),
  "network.forget": (ctx: ServiceContext) => {
    const file = storePath(ctx.requireRoot());
    try { if (fs.lstatSync(file).isFile()) fs.rmSync(file); } catch { /* nothing saved */ }
    return NONE;
  },
} satisfies Partial<HandlerTable>;
