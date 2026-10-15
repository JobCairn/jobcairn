// The one message scrub for CareerOS (video pipeline and Claude Code runs): the video lane's path rules with their fix
// rounds (FRAGMENT_ABS, %2F / %5C and hashbang fragments), plus the Claude engine's ANSI stripping and token redaction.

/** ANSI CSI sequences (colours, cursor moves) and OSC sequences (terminal links, titles). */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Key and token shapes that must never be shown: Anthropic, GitHub, Slack. */
const TOKENS = /\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}/g;

/** No terminal codes, control or invisible characters, or keys; newlines to spaces; at most `max` characters. */
export function oneLine(text: string, max = 300): string {
  return text.replace(ANSI, "").replace(TOKENS, "[hidden key]").replace(/[\p{Cf}]/gu, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Kept verbatim: http(s)/ws(s) links whose host starts with a real character (not "/"), not glued
// to a longer scheme name ("foo-https://"), and cut at a comma followed by "/" so a path glued on
// after one is still scrubbed (Fix round 3, R1). The scheme is matched case-insensitively (the
// whole regex runs with the "i" flag below) so "HTTPS://..." and "Https://..." are kept too.
const KEEP_URL = String.raw`(?<![A-Za-z0-9+.\-])(?:https?|wss?):\/\/[^\s\/\\"'` + "`" + String.raw`<>,][^\s"'` + "`" + String.raw`<>,]*(?:,(?!\/)[^\s"'` + "`" + String.raw`<>,]*)*`;
// Any other scheme://... (file:, vscode:, custom, or an empty host) - two or more letters, so a
// single letter plus ":" is always a drive path below, never a scheme.
const OTHER_URL = String.raw`(?<![A-Za-z0-9+.\-])[A-Za-z][A-Za-z0-9+.\-]+:\/\/[^\s"'` + "`" + String.raw`<>]*`;
const TAIL = String.raw`[^\s"'` + "`" + String.raw`<>,;)]*`;
const DRIVE_PATH = String.raw`(?<![\w.~\-])[A-Za-z]:[\\\/]+` + TAIL;
const POSIX_PATH = String.raw`(?<![\w.~\-])\/(?:[^\s\/\\]+[\\\/])+` + TAIL;
const SCRUB_RE = new RegExp(`(${KEEP_URL})|${OTHER_URL}|${DRIVE_PATH}|${POSIX_PATH}`, "gi");

// A kept link can still smuggle a real filesystem path past the keep rule: a query value that
// starts with "/", "%2F"/"%2f" or "%5C"/"%5c" (`?p=/opt/secret/y`, `?p=%2Fopt%2Fsecret%2Fy`), or a
// Vite dev-server `/@fs/<abs path>` segment (Vite serves an absolute path through a URL that way).
// Both still become "a file"; the rest of the link (scheme, host, other params) is left alone.
// Carried over from the Task 16 review.
const QUERY_ABS_VALUE = String.raw`([?&][^=&\s"'` + "`" + String.raw`<>]*=)(?:\/|%2[Ff]|%5[Cc])[^\s"'` + "`" + String.raw`<>,;)&]*`;
const VITE_FS_PATH = String.raw`\/@fs\/[^\s"'` + "`" + String.raw`<>,;)&?#]*`;
const QUERY_ABS_VALUE_RE = new RegExp(QUERY_ABS_VALUE, "gi");
const VITE_FS_PATH_RE = new RegExp(VITE_FS_PATH, "g");
// Fix round 1: a fragment (the part after "#") is never split off by KEEP_URL, so an absolute
// path hidden there - `#/opt/secret/y`, `#%2Fopt%2Fsecret%2Fy`, `#/@fs/<abs path>` - used to survive
// verbatim. A fragment that starts with one of those markers becomes "a file" whole; a plain anchor
// (`#section`) is left alone.
// Fix round 2: a client-side-routing "hashbang" fragment (`#!/opt/secret`, `#?/opt/x`) hides the
// same absolute path behind leading `!`, `?` or `~` punctuation, so that punctuation is skipped
// before the same check runs. `#!section` and `#?section` (no path behind the punctuation) still
// count as a plain anchor and are left alone.
const FRAGMENT_ABS = /^[!?~]*(?:\/|%2[Ff]|%5[Cc])/;

/** Scrubs the absolute-path segments a kept http(s)/ws(s) link can still carry: a `?p=/abs/path`
 * (or percent-encoded) query value, a Vite `/@fs/abs/path` segment, or an absolute path hidden in
 * the fragment after "#". The rest of the link is left untouched. */
function scrubInsideKeptUrl(url: string): string {
  const scrub = (s: string) => s.replace(VITE_FS_PATH_RE, "/@fs/a file").replace(QUERY_ABS_VALUE_RE, "$1a file");
  const hashAt = url.indexOf("#");
  if (hashAt === -1) return scrub(url);
  const before = url.slice(0, hashAt);
  const fragment = url.slice(hashAt + 1);
  return `${scrub(before)}#${FRAGMENT_ABS.test(fragment) ? "a file" : scrub(fragment)}`;
}

/** One line, safe to show: the video lane's rules (workspace paths relative, other paths and non-web links "a file"). */
export function scrubMessage(text: unknown, rootDir: string, max = 300): string {
  const root = rootDir.replace(/[\\/]+$/, "");
  const r = escapeRegExp(root);
  let t = oneLine(String(text ?? ""), max * 4);
  if (root) {
    t = t
      .replace(new RegExp(String.raw`${r}[\\/]+(?=[^\s"'` + "`" + String.raw`<>])`, "g"), "")
      .replace(new RegExp(String.raw`${r}(?=[\\/\s"'` + "`" + String.raw`,;:!?)\]]|\.(?=\s|$)|$)`, "g"), "your workspace")
      .replace(new RegExp(String.raw`${r}\S*`, "g"), "a file");
  }
  return t.replace(SCRUB_RE, (_m, keep: string | undefined) => (keep ? scrubInsideKeptUrl(keep) : "a file")).slice(0, max).trim();
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
