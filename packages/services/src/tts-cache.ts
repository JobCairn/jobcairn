// Read-aloud audio cache: <workspace>/.careeros/cache/tts/<sha256>.wav, least recently used first out, 200 MB cap.
// The key covers everything that changes the sound (text, voice, language, engine and its version),
// never the playback speed, which the player applies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { insideRoot } from "@careeros/core";
import { TTS_CACHE_NAME, type TtsEngine, type TtsOptions } from "@careeros/contract";

/** Bump when the narrator's output for the same input changes (padding, loudness, model). */
export const ENGINE_VERSION = "narrate-2/supertonic-3"; // 2: 0.06 s tail per chunk (was 0.25 s), for gapless playback
export const CACHE_CAP_BYTES = 200 * 1024 * 1024;
const SEGMENTS = [".careeros", "cache", "tts"] as const;

export function cacheKey(text: string, opts: TtsOptions, engine: TtsEngine): string {
  // Read aloud never uses expressions, so they aren't part of the key.
  const material = JSON.stringify([ENGINE_VERSION, engine, opts.voice, opts.lang, text]);
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

export const cacheDirFor = (root: string): string => path.join(root, ...SEGMENTS);

const PRIVATE_SEGMENTS = [".careeros", "tts-private"] as const;
/** Audio made from an unlocked locked-folder file. Wiped on every open, close and privacy change. */
export const privateDirFor = (root: string): string => path.join(root, ...PRIVATE_SEGMENTS);

/** Creates the cache folder (refusing any link on the way) and its own .gitignore. Returns the folder. */
export function ensureCacheDir(root: string): string { return ensureDir(root, SEGMENTS); }
export function ensurePrivateDir(root: string): string { return ensureDir(root, PRIVATE_SEGMENTS); }

function ensureDir(root: string, segments: readonly string[]): string {
  let dir = root;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(dir); } catch { st = undefined; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error("The read-aloud cache folder isn't a real folder, so nothing was saved.");
    if (!st) fs.mkdirSync(dir, { mode: 0o700 });
  }
  if (!insideRoot(root, dir)) throw new Error("The read-aloud cache folder is outside the workspace.");
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# Read-aloud audio. Rebuilt on demand; never commit.\n*\n", { mode: 0o600 });
  return dir;
}

/** A plain, single-named, non-empty regular file at `file`, or null. */
function plainFile(file: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.nlink === 1 && st.size > 0 ? st : null;
  } catch { return null; }
}

/** The cached file for `key`, marked as just used, or null on a miss. */
export function cachedFile(root: string, key: string, now = new Date()): string | null {
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const file = path.join(cacheDirFor(root), `${key}.wav`);
  if (!plainFile(file)) return null;
  try { fs.utimesSync(file, now, now); } catch { /* still usable; it just ages sooner */ }
  return file;
}

/** Moves a finished WAV into tts-private/ under `key` (never pruned into the shared cache; wiped instead). */
export function storePrivate(root: string, key: string, src: string): string {
  const dest = path.join(ensurePrivateDir(root), `${key}.wav`);
  try { fs.renameSync(src, dest); } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
  return dest;
}

/** Deletes everything in tts-private/ (a link there is removed, never followed). Returns how many files went. */
export function wipePrivate(root: string): number {
  const dir = privateDirFor(root);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return 0; }
  if (!st.isDirectory()) { fs.rmSync(dir, { force: true }); return 0; }
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name === ".gitignore") continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++; } catch { /* try the rest */ }
  }
  return n;
}

/** Moves a finished WAV into the cache under `key`, then trims the cache to the cap (never removing this one). */
export function storeFile(root: string, key: string, src: string, cap = CACHE_CAP_BYTES): string {
  const dir = ensureCacheDir(root);
  const dest = path.join(dir, `${key}.wav`);
  try { fs.renameSync(src, dest); } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
  prune(dir, cap, `${key}.wav`);
  return dest;
}

/** Deletes the least recently used WAVs until the folder is within `cap` bytes. Returns how many were removed. */
export function prune(dir: string, cap = CACHE_CAP_BYTES, keep?: string): number {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const entries = names.filter((n) => TTS_CACHE_NAME.test(n)).flatMap((n) => {
    try {
      const st = fs.lstatSync(path.join(dir, n));
      return st.isFile() ? [{ n, size: st.size, used: st.mtimeMs }] : [];
    } catch { return []; }
  });
  let total = entries.reduce((s, e) => s + e.size, 0);
  let removed = 0;
  for (const e of entries.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    if (e.n === keep) continue;
    try { fs.rmSync(path.join(dir, e.n), { force: true }); total -= e.size; removed++; } catch { /* try the next one */ }
  }
  return removed;
}

export function cacheSize(root: string): number {
  const dir = cacheDirFor(root);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  return names.filter((n) => TTS_CACHE_NAME.test(n)).reduce((s, n) => {
    try { return s + fs.lstatSync(path.join(dir, n)).size; } catch { return s; }
  }, 0);
}

/** Removes every cached WAV (or only `keys`). Returns how many files went. */
export function clearCache(root: string, keys?: Iterable<string>): number {
  const dir = cacheDirFor(root);
  let names: string[];
  try { names = keys ? [...keys].map((k) => `${k}.wav`) : fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!TTS_CACHE_NAME.test(name)) continue;
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try { fs.rmSync(f, { force: true }); n++; } catch { /* leave it */ }
  }
  return n;
}
