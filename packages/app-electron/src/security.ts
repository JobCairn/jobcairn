import path from "node:path";

export const APP_ORIGIN = "app://careeros";

// e2e covers inline-script blocking only; adding 'unsafe-eval' alone would not fail any test, so keep it out.
export const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self' careeros-file:", "media-src careeros-file:",
  // The email viewer: a sandboxed frame that loads stored messages from careeros-mail:. The file viewer: a frame that
  // shows one workspace PDF from careeros-file: in the built-in PDF viewer (see frameNavigation).
  "frame-src careeros-mail: careeros-file:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
].join("; ");

/**
 * Subframes (the email viewer) may load stored-message documents only; a click on a rewritten link becomes the
 * link dialog instead of a navigation. Everything else a frame tries is blocked. Main-frame navigation is always
 * blocked by will-navigate, so a main-frame URL is never allowed here either.
 */
export function frameNavigation(url: string, isMainFrame: boolean): "allow" | "block" | "link" {
  if (isMainFrame) return "block";
  if (url.startsWith("careeros-mail://msg/")) return "allow";
  if (isWorkspacePdf(url) || url.startsWith(`${PDF_VIEWER}/`)) return "allow";
  if (url.startsWith("careeros-mail://link/")) return "link";
  return "block";
}

/**
 * Chromium's built-in PDF viewer (a fixed component extension id). A workspace PDF in a frame opens it as an inner frame;
 * blocking it leaves the PDF blank. It only ever shows the PDF it was handed.
 */
export const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";

/** careeros-file://ws/....pdf: the file viewer's frame. The scheme handler still checks the workspace, locks and kind. */
export function isWorkspacePdf(url: string): boolean {
  const rel = fileUrlToRel(url);
  return !!rel && /\.pdf$/i.test(rel) && !/[?#]/.test(url);
}

// C0 and C1 control characters, DEL included (NUL, CR, LF, TAB, ESC ...).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** app://careeros/<path> -> a file inside the renderer folder, or null. */
export function appFileFor(rendererDir: string, url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "app:" || u.host !== "careeros") return null;
  let rel: string;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel === "" || rel === "/") rel = "/index.html";
  if (CONTROL.test(rel) || rel.includes("\\")) return null;
  const root = path.resolve(rendererDir);
  const abs = path.resolve(root, `.${rel}`);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * careeros-file://ws/<encoded segments> -> "a/b/c", or null.
 * Each segment is decoded exactly once, matching the renderer's single per-segment encodeURIComponent (`fileUrlFor`).
 * After decoding, a segment may not be empty, "." or "..", hold a control character, or hold a slash or backslash
 * (an encoded separator), and the result may not be an absolute path. The services then check the real path,
 * the workspace boundary, the file kind and the folder locks (`resolveWorkspaceFile(..., "media")`).
 */
export function fileUrlToRel(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "careeros-file:" || u.host !== "ws" || u.username || u.password) return null;
  const parts = u.pathname.split("/").slice(1);
  let decoded: string[];
  try { decoded = parts.map((p) => decodeURIComponent(p)); } catch { return null; }
  if (!decoded.length) return null;
  if (decoded.some((p) => p === "" || p === "." || p === ".." || CONTROL.test(p) || p.includes("/") || p.includes("\\"))) return null;
  const rel = decoded.join("/");
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  return rel;
}

export function isTrustedSender(frameUrl: string | undefined, devUrl: string | null): boolean {
  if (!frameUrl) return false;
  if (frameUrl.startsWith(`${APP_ORIGIN}/`)) return true;
  return !!devUrl && frameUrl.startsWith(devUrl.replace(/\/?$/, "/"));
}

/**
 * What a failed IPC call sends to the renderer: a fresh Error carrying only a plain `name` and the first line of
 * `message`. No stack, cause, code, errno or path fields survive (the services' plainError already scrubs paths).
 */
export function rendererError(err: unknown): Error {
  const e = err && typeof err === "object" ? (err as { name?: unknown; message?: unknown }) : null;
  const name = e && typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
  const raw = e && typeof e.message === "string" ? e.message : typeof err === "string" ? err : "";
  const message = raw.split("\n")[0]!.trim().slice(0, 500) || "Something went wrong.";
  const out = new Error(message);
  if (name !== "Error") out.name = name;
  out.stack = `${name}: ${message}`;
  return out;
}

/**
 * The confirm shown before a link leaves the app. The host comes from `new URL(u).host`, so a user-info part
 * can't disguise it ("ok.example.com", then an at sign, then "evil.example" shows evil.example); the detail repeats the full address.
 */
export function linkPrompt(url: string): { message: string; detail: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!u.host) return null;
  return { message: `Open ${u.host} in your browser?`, detail: `Full address:\n${u.href}` };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
export const contentType = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export function devUrlFrom(env: Record<string, string | undefined>, packaged: boolean): string | null {
  const u = env.CAREEROS_DEV_URL;
  return !packaged && u && /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(u) ? u.replace(/\/$/, "") : null;
}
