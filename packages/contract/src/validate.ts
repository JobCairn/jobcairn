export class ArgError extends Error {
  constructor(message: string) { super(message); this.name = "ArgError"; }
}
export type V<T> = (v: unknown, at: string) => T;

const fail = (at: string, what: string): never => { throw new ArgError(`${at} ${what}`); };
const CTRL = /[\x00-\x1f\x7f]/;
// Control characters that are never legitimate in any text field (logs, shells, terminals
// all mis-render these). \t (0x09), \n (0x0A) and \r (0x0D) are excluded here because a
// multi-line note is allowed to contain them; single-line fields reject them separately below.
const CTRL_ALWAYS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const str = (o: { min?: number; max: number; pattern?: RegExp; multiline?: boolean }): V<string> => (v, at) => {
  if (typeof v !== "string") return fail(at, "must be text");
  if (CTRL_ALWAYS.test(v)) fail(at, "contains a control character");
  if (!o.multiline && /[\t\n]/.test(v)) fail(at, "must be a single line");
  if (v.length < (o.min ?? 0)) fail(at, o.min === 1 ? "is required" : `must be at least ${o.min} characters`);
  if (v.length > o.max) fail(at, `must be at most ${o.max} characters`);
  if (o.pattern && !o.pattern.test(v)) fail(at, "has an invalid format");
  return v;
};
export const int = (min: number, max: number): V<number> => (v, at) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail(at, `must be a whole number from ${min} to ${max}`);
export const num = (min: number, max: number): V<number> => (v, at) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fail(at, `must be a number from ${min} to ${max}`);
export const bool: V<boolean> = (v, at) => (typeof v === "boolean" ? v : fail(at, "must be true or false"));
export const oneOf = <T extends string>(values: readonly T[]): V<T> => (v, at) =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fail(at, `must be one of: ${values.map((x) => (x === "" ? '""' : x)).join(", ")}`);
export const arr = <T>(of: V<T>, o: { min?: number; max: number }): V<T[]> => (v, at) => {
  if (!Array.isArray(v)) return fail(at, "must be a list");
  if (v.length < (o.min ?? 0)) fail(at, `must have at least ${o.min} item(s)`);
  if (v.length > o.max) fail(at, `must have at most ${o.max} items`);
  return v.map((x, i) => of(x, `${at}[${i}]`));
};
export const opt = <T>(inner: V<T>): V<T | undefined> => (v, at) => (v === undefined ? undefined : inner(v, at));
export function obj<S extends Record<string, V<unknown>>>(shape: S): V<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (v, at) => {
    if (!isPlain(v)) return fail(at, "must be an object");
    for (const k of Object.keys(v)) if (!Object.hasOwn(shape, k) || BANNED_KEYS.has(k)) fail(`${at}.${k}`, "is not allowed");
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(shape)) {
      const r = val(v[k], `${at}.${k}`);
      if (r !== undefined) out[k] = r;
    }
    return out as { [K in keyof S]: ReturnType<S[K]> };
  };
}
/** Any JSON value, bounded in size and depth, with no prototype keys. */
export const json: V<unknown> = (v, at) => {
  const walk = (x: unknown, depth: number, where: string): void => {
    if (depth > 6) fail(where, "is nested too deeply");
    if (x === null || typeof x === "boolean") return;
    if (typeof x === "number") { if (!Number.isFinite(x)) fail(where, "must be a finite number"); return; }
    if (typeof x === "string") { if (x.length > 10_000) fail(where, "is too long"); return; }
    if (Array.isArray(x)) { if (x.length > 200) fail(where, "has too many items"); x.forEach((y, i) => walk(y, depth + 1, `${where}[${i}]`)); return; }
    if (isPlain(x)) {
      const keys = Object.keys(x);
      if (keys.length > 200) fail(where, "has too many keys");
      for (const k of keys) { if (BANNED_KEYS.has(k)) fail(`${where}.${k}`, "is not allowed"); walk(x[k], depth + 1, `${where}.${k}`); }
      return;
    }
    fail(where, "must be plain JSON");
  };
  walk(v, 0, at);
  return v;
};

export const slug = str({ min: 1, max: 120, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ });
export const queueId = str({ min: 1, max: 80, pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/ });
/** A hex SHA-256, as in ApprovalView.digest. */
export const digest = str({ min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ });
export const fileName: V<string> = (v, at) => {
  const s = str({ min: 1, max: 255 })(v, at);
  if (CTRL.test(s) || s.includes("/") || s.includes("\\") || s === "." || s === "..") fail(at, "must be a plain file name");
  return s;
};
export const absPath: V<string> = (v, at) => {
  const s = str({ min: 1, max: 4096 })(v, at);
  if (CTRL.test(s)) fail(at, "contains control characters");
  if (!(s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\"))) fail(at, "must be an absolute path");
  return s;
};
export const relPath: V<string> = (v, at) => {
  const s = str({ min: 1, max: 1024 })(v, at);
  if (CTRL.test(s) || s.startsWith("/") || s.includes("\\") || /^[A-Za-z]:/.test(s)) fail(at, "must be a workspace-relative path");
  if (s.split("/").some((p) => p === "" || p === "." || p === "..")) fail(at, "must not contain empty, . or .. segments");
  return s;
};
export const settingsPath: V<string> = (v, at) => {
  const s = str({ min: 1, max: 200, pattern: /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/ })(v, at);
  if (s.split(".").some((p) => BANNED_KEYS.has(p))) fail(at, "is not allowed");
  return s;
};
/**
 * A URL the shell is allowed to open externally (the user's default browser). Must be
 * https, with a real hostname and no embedded credentials, so a crafted `javascript:`,
 * `file:`, `data:` or `user:pw@host` link can never reach `shell.openExternal`.
 */
export const httpsUrl: V<string> = (v, at) => {
  const s = str({ min: 1, max: 2048 })(v, at);
  let u: URL;
  try { u = new URL(s); } catch { return fail(at, "must be a valid URL"); }
  if (u.protocol !== "https:") fail(at, "must be an https:// URL");
  if (!u.hostname) fail(at, "must have a hostname");
  if (u.username || u.password) fail(at, "must not contain a username or password");
  return s;
};
/**
 * Boolean twin of `httpsUrl`, for callers that want to ask "is this safe?" rather than
 * throw: plain https, a real hostname, no embedded username or password. Shared by
 * services' `isSafeLink` and the renderer (the Approvals screen, `MockBridge`), so none
 * of them can quietly drift from what the IPC boundary itself allows through. `@careeros/core`
 * keeps its own copy of this same rule for `proposeApproval` rather than importing it,
 * since `core` ships a plain Node build and must not pick up a workspace-source-only
 * dependency - see the comment there.
 */
export function isSafeHttpsUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
}
/** A single path segment: no separators, no ".." traversal, no leading dot, no control chars. */
export const segmentName: V<string> = (v, at) => {
  const s = str({ min: 1, max: 120 })(v, at);
  if (s.startsWith(".") || s.includes("/") || s.includes("\\") || s.includes("..")) fail(at, "must not start with '.' or contain '/', '\\' or '..'");
  return s;
};
