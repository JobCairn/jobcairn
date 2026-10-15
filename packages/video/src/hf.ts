import path from "node:path";
import { CancelledError, lastLine, oneLine, VideoError } from "./errors.js";
import { cleanEnv, OFFLINE_ENV, type ProcessRunner, type RunResult } from "./process.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const HF_VERSION = "0.8.140";
export const HF_ALLOWED = ["transcribe", "lint", "check", "snapshot", "render", "--version"] as const;
export type HfCommand = (typeof HF_ALLOWED)[number];
/**
 * The captions model. Captions only time a script that is already known, so the small base.en model (about 140 MB)
 * is enough and is what CareerOS installs. A computer that already has small.en (about 470 MB, the old default)
 * keeps using it: whatever is installed is used, and nothing is downloaded again.
 */
export const CAPTIONS_MODELS = ["small.en", "base.en"] as const;
export type CaptionsModel = (typeof CAPTIONS_MODELS)[number];
export const DEFAULT_CAPTIONS_MODEL: CaptionsModel = "base.en";
/** The model the installer downloads. Kept under its old name for callers that only need "the" model. */
export const TRANSCRIBE_MODEL: CaptionsModel = DEFAULT_CAPTIONS_MODEL;

/** Where HyperFrames keeps a whisper model (`~/.cache/hyperframes/whisper/models/ggml-<model>.bin`). */
export function captionsModelFile(home: string, model: CaptionsModel, join: (...p: string[]) => string = path.join): string {
  return join(home, ".cache", "hyperframes", "whisper", "models", `ggml-${model}.bin`);
}

/** The installed captions model to use: small.en when it is already there (better, and already paid for), else
 * base.en, else null (none installed). Never picks a model that would have to be downloaded. */
export function pickCaptionsModel(installed: (model: CaptionsModel) => boolean): CaptionsModel | null {
  return CAPTIONS_MODELS.find((m) => installed(m)) ?? null;
}
const MINUTE = 60_000;
// A day, in seconds - a generous upper bound for a snapshot time, past which formatTime's own
// exponent-notation safeguard breaks down (Fix round 2, item 3).
const MAX_SNAPSHOT_SECONDS = 86_400;

export interface HfPaths { node: string; cli: string; ffmpeg: string; ffprobe: string; chrome: string | null }
/** `section`: which part of `hyperframes check` found it (lint, runtime, layout, motion, contrast). */
export interface LintFinding { code: string; severity: string; message: string; section?: string }
/** `note`: a plain sentence about a part of the check that didn't run or couldn't be read (never blocks). */
export interface LintReport { ok: boolean; errorCount: number; warningCount: number; findings: LintFinding[]; note?: string }
export interface ProbeResult { duration: number; width: number; height: number; video: boolean; audio: boolean }
interface CallOpts { cwd: string; signal?: AbortSignal; onLine?: (l: string, s: "stdout" | "stderr") => void; timeoutMs?: number; lowPriority?: boolean; env?: Record<string, string> }

export function parseProgress(line: string): number | null {
  const m = /^@hf-progress\s+(\{.*\})\s*$/.exec(line.trim());
  if (!m) return null;
  try {
    const pct = (JSON.parse(m[1]!) as { pct?: unknown }).pct;
    return typeof pct === "number" && pct >= 0 && pct <= 100 ? pct : null;
  } catch { return null; }
}

/** A finite non-negative integer, or `null` for anything else (including the ordinary
 * JSON-number case of a negative or fractional value) - parseLint treats `null` here as "the
 * whole report is unreadable", not as "clamp to 0", so a tool reporting a nonsensical
 * errorCount: -1 can't come back as a LintReport a caller might read as "no errors" (Fix round 1,
 * item 6). */
function count(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Where the balanced JSON value starting at `at` (a "{") ends, string-aware; -1 when it never closes. */
function objectEnd(text: string, at: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The last JSON object in a tool's stdout. A CLI can print log lines before its report (a font cache notice, an npm
 * warning) and after it (a "Done" line, an update notice), and those can hold braces too. Candidates are the "{"s
 * that start a line (indented or not); each is cut at its matching "}" and parsed, and the last whole one wins. The first "{" anywhere is the fallback.
 */
export function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const starts: number[] = [];
  let lineStart = true;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!;
    if (ch === "\n" || ch === "\r") { lineStart = true; continue; }
    if (ch === "{" && lineStart) starts.push(i);
    if (ch !== " " && ch !== "\t") lineStart = false;
  }
  const first = stdout.indexOf("{");
  if (first >= 0 && !starts.includes(first)) starts.unshift(first);
  // In order, skipping anything inside an object already read (a pretty-printed report's nested objects also start
  // lines); the last whole object wins.
  let found: Record<string, unknown> | undefined;
  let after = -1;
  for (const at of starts) {
    if (at <= after) continue;
    const end = objectEnd(stdout, at);
    if (end < 0) continue;
    try {
      const j: unknown = JSON.parse(stdout.slice(at, end + 1));
      if (j && typeof j === "object" && !Array.isArray(j)) { found = j as Record<string, unknown>; after = end; }
    } catch { /* not this one */ }
  }
  return found;
}

const clean = (f: { code?: unknown; severity?: unknown; message?: unknown }, section?: string): LintFinding => ({
  // Fix round 2, item 2: all three fields go through oneLine() so a CR/LF can't forge a second line.
  code: oneLine(String(f.code ?? "")), severity: oneLine(String(f.severity ?? "")), message: oneLine(String(f.message ?? "")),
  ...(section ? { section } : {}),
});
const findingsOf = (x: unknown, section?: string): LintFinding[] =>
  (Array.isArray(x) ? x : []).filter((f): f is Record<string, unknown> => !!f && typeof f === "object").map((f) => clean(f, section));
/** A report's counts: the stated ones when present (refused when nonsensical), else counted from its findings. */
function counts(j: Record<string, unknown>, findings: LintFinding[]): { errorCount: number; warningCount: number } {
  const errorCount = j.errorCount === undefined ? findings.filter((f) => f.severity === "error").length : count(j.errorCount);
  const warningCount = j.warningCount === undefined ? findings.filter((f) => f.severity === "warning").length : count(j.warningCount);
  if (errorCount === null || warningCount === null) throw new Error("bad counts");
  return { errorCount, warningCount };
}

export interface ParseContext { code?: number; stderr?: string; skipSections?: string[] }

/**
 * Reads `hyperframes lint --json` and `hyperframes check --json` (0.8.140). Lint's report is flat (ok, errorCount,
 * warningCount, findings). Check's is sectioned: lint, runtime, layout, motion and contrast each carry their own
 * counts and findings, and there are no top-level counts. Reading check's report as a flat one is what made every
 * video stop with "HyperFrames gave an answer ... could not read". `skipSections` leaves sections out (check repeats
 * lint, which already ran). A crash (`{ ok: false, error }`) is a tool failure with its reason, never a pass.
 */
export function parseLint(stdout: string, ctx: ParseContext = {}): LintReport {
  const j = lastJsonObject(stdout);
  try {
    if (!j) throw new Error("no report");
    if (j.ok === false && typeof j.error === "string" && j.error.trim()) {
      return { ok: false, errorCount: 1, warningCount: 0, findings: [{ code: "tool_error", severity: "error", message: `HyperFrames stopped: ${oneLine(j.error).slice(0, 200)}` }] };
    }
    const sections = Object.entries(j).filter(([k, v]) => !k.startsWith("_") && v && typeof v === "object" && !Array.isArray(v) && ("errorCount" in v || Array.isArray((v as { findings?: unknown }).findings)));
    const flat = "errorCount" in j || Array.isArray(j.findings) || !sections.length;
    if (flat) {
      const findings = findingsOf(j.findings);
      const c = counts(j, findings);
      if (!("errorCount" in j) && !Array.isArray(j.findings)) throw new Error("no counts");
      return { ok: !!j.ok && c.errorCount === 0, ...c, findings };
    }
    const skip = new Set(ctx.skipSections ?? []);
    let errorCount = 0, warningCount = 0;
    const findings: LintFinding[] = [];
    for (const [name, v] of sections) {
      if (skip.has(name)) continue;
      const sec = v as Record<string, unknown>;
      const f = findingsOf(sec.findings, name);
      const c = counts(sec, f);
      errorCount += c.errorCount;
      warningCount += c.warningCount;
      findings.push(...f);
    }
    if (j.browserSkipped === true) {
      warningCount++;
      findings.push({ code: "browser_skipped", severity: "warning", message: "HyperFrames could not open a browser, so the layout and contrast checks were skipped." });
    }
    return { ok: errorCount === 0, errorCount, warningCount, findings };
  } catch {
    const said = lastLine(ctx.stderr ?? "") || lastLine(stdout);
    const detail = [ctx.code !== undefined && ctx.code !== 0 ? `exit code ${ctx.code}` : "", said ? `it said "${said.slice(0, 160)}"` : ""].filter(Boolean).join(", ");
    return { ok: false, errorCount: 1, warningCount: 0, findings: [{ code: "unreadable", severity: "error", message: `HyperFrames gave an answer ${identity.name} could not read${detail ? ` (${detail})` : ""}.` }] };
  }
}

function badArg(message: string): never {
  throw new VideoError("bad_arg", message);
}

/** Formats a snapshot time as a plain decimal with no exponent notation (JS's default
 * Number->string flips to "1e+21"/"1e-7" style notation outside a normal range, and a stray "e"
 * in a "--at" value could confuse the CLI's own parsing) and no superfluous trailing zeros, e.g.
 * 9 -> "9", 1.5 -> "1.5" (Fix round 1, item 3). Only ever called with an already-validated finite,
 * non-negative time. */
function formatTime(t: number): string {
  return t.toFixed(2).replace(/\.?0+$/, "");
}

function ensure(r: RunResult, what: string): RunResult {
  if (r.cancelled) throw new CancelledError();
  if (r.timedOut) throw new VideoError("timeout", `${what} took too long and was stopped.`);
  if (r.code !== 0) throw new VideoError("tool_failed", `${what}: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit code ${r.code}`}`);
  return r;
}

export class HfCli {
  constructor(private runner: ProcessRunner, readonly paths: HfPaths, private platform: NodeJS.Platform = process.platform) {}

  env(extra: Record<string, string> = {}): Record<string, string> {
    return cleanEnv({
      HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1", NO_COLOR: "1", ...OFFLINE_ENV,
      HYPERFRAMES_FFMPEG_PATH: this.paths.ffmpeg, HYPERFRAMES_FFPROBE_PATH: this.paths.ffprobe,
      ...(this.paths.chrome ? { HYPERFRAMES_BROWSER_PATH: this.paths.chrome } : {}), ...extra,
    });
  }

  /** Runs `<node> <cli> <cmd> ...args` directly - never through a shell, never via `npx` - after
   * checking `cmd` against `HF_ALLOWED`. The check happens before anything is started (Task 13
   * finds `paths`; nothing here resolves or installs HyperFrames itself). */
  async run(cmd: string, args: string[], o: CallOpts): Promise<RunResult> {
    if (!(HF_ALLOWED as readonly string[]).includes(cmd)) {
      throw new VideoError("hf_refused", `${identity.name} does not run "hyperframes ${cmd.slice(0, 40)}". Only transcribe, lint, check, snapshot and render are allowed.`);
    }
    return this.runner.run(this.paths.node, [this.paths.cli, cmd, ...args], {
      cwd: o.cwd, signal: o.signal, onLine: o.onLine, timeoutMs: o.timeoutMs ?? 10 * MINUTE, lowPriority: o.lowPriority, env: this.env(o.env),
    });
  }

  async version(cwd: string): Promise<string> {
    return lastLine(ensure(await this.run("--version", [], { cwd, timeoutMs: MINUTE }), "HyperFrames").stdout).replace(/^v/, "");
  }

  /** `audioRel` must be a non-empty, safe relative path - never absolute, never starting with "-"
   * (which a lenient argv parser could read as a flag rather than the positional filename it's
   * supposed to be), and never containing a ".." segment (Fix round 1, item 3), nor empty (Fix
   * round 2, item 6: an empty string passed every one of those checks and reached the runner as a
   * bare positional argument). Checked, and refused with `VideoError("bad_arg")`, before the
   * runner is ever called. */
  async transcribe(cwd: string, audioRel: string, o: { signal?: AbortSignal; model?: CaptionsModel } = {}): Promise<void> {
    if (audioRel === "" || path.isAbsolute(audioRel) || audioRel.startsWith("-") || audioRel.split(/[\\/]/).includes("..")) {
      badArg("the audio path must be a safe, non-empty relative path.");
    }
    const model = o.model ?? DEFAULT_CAPTIONS_MODEL;
    if (!(CAPTIONS_MODELS as readonly string[]).includes(model)) badArg("the captions model must be small.en or base.en.");
    ensure(await this.run("transcribe", [audioRel, "--model", model, "--language", "en"], { cwd, signal: o.signal, timeoutMs: 30 * MINUTE, lowPriority: true }), "Transcription failed");
  }

  // lint/check don't use ensure(): a non-zero exit code is an expected, meaningful result here
  // (HyperFrames exits non-zero when lint/check find errors, not when the tool itself failed), so
  // only cancelled and timed-out are checked directly - and timedOut must be checked explicitly
  // (Fix round 1, item 7): a killed-for-timeout run has empty/partial stdout, which parseLint's
  // own catch-all would otherwise report as "HyperFrames gave an answer CareerOS could not read",
  // masking the real cause.
  async lint(cwd: string, signal?: AbortSignal): Promise<LintReport> {
    const r = await this.run("lint", ["--json"], { cwd, signal });
    if (r.cancelled) throw new CancelledError();
    if (r.timedOut) throw new VideoError("timeout", "Lint took too long and was stopped.");
    return parseLint(r.stdout, { code: r.code, stderr: r.stderr });
  }

  /** `skipSections`: parts of check's sectioned report to leave out (its own copy of lint, when lint already ran). */
  async check(cwd: string, signal?: AbortSignal, o: { skipSections?: string[] } = {}): Promise<LintReport> {
    const r = await this.run("check", ["--json"], { cwd, signal, lowPriority: true });
    if (r.cancelled) throw new CancelledError();
    if (r.timedOut) throw new VideoError("timeout", "Check took too long and was stopped.");
    return parseLint(r.stdout, { code: r.code, stderr: r.stderr, skipSections: o.skipSections });
  }

  /** `times` must be non-empty, and every value finite, zero or later, and at most a day (Fix
   * round 1, item 3; Fix round 2, item 3) - checked, and refused with `VideoError("bad_arg")`,
   * before the runner is ever called. The upper bound exists because `formatTime`'s own
   * exponent-notation safeguard breaks down past it (1e21 flips `toFixed` itself into exponent
   * notation, and the trailing-zero stripper then mangles that further - 1e30 becomes "1e+3", not
   * "1e+30"); no real video could ever need a snapshot that far out anyway. Formatted with
   * `formatTime` so the joined "--at" value never contains exponent notation. */
  async snapshot(cwd: string, times: number[], signal?: AbortSignal): Promise<void> {
    if (times.length === 0) badArg("snapshot needs at least one time.");
    for (const t of times) {
      if (!Number.isFinite(t) || t < 0 || t > MAX_SNAPSHOT_SECONDS) {
        badArg(`snapshot times must be finite, zero or later, and at most ${MAX_SNAPSHOT_SECONDS} seconds.`);
      }
    }
    ensure(await this.run("snapshot", ["--at", times.map(formatTime).join(",")], { cwd, signal, lowPriority: true }), "The preview pictures failed");
  }

  /** Below-normal priority and a 2-hour ceiling (renders are the one long-running command); GPU
   * capture plus the parallel-stream env var only on macOS, software encode elsewhere. `outAbs`
   * must be absolute and not start with "-" (same argv-as-flag concern as `audioRel` above), and
   * `quality` must be exactly "draft" or "final" even though the type already says so - this is a
   * runtime boundary, not just a compile-time one (Fix round 1, item 3). Both are refused with
   * `VideoError("bad_arg")` before the runner is ever called. */
  async render(cwd: string, outAbs: string, quality: "draft" | "final", o: { signal?: AbortSignal; onPct?: (p: number) => void }): Promise<void> {
    if (!path.isAbsolute(outAbs) || outAbs.startsWith("-")) badArg("the output path must be an absolute path.");
    if (quality !== "draft" && quality !== "final") badArg('quality must be "draft" or "final".');
    const mac = this.platform === "darwin";
    const args = [...(quality === "draft" ? ["--quality", "draft"] : []), "--output", outAbs, ...(mac ? ["--gpu"] : [])];
    const r = await this.run("render", args, {
      cwd, signal: o.signal, lowPriority: true, timeoutMs: 120 * MINUTE, env: mac ? { HF_CAPTURE_PARALLEL_STREAM: "true" } : {},
      onLine: (l) => { const p = parseProgress(l); if (p !== null) o.onPct?.(p); },
    });
    ensure(r, "The render stopped");
  }
}

/** A finite, strictly positive integer, and nothing else - a string like "1920" is refused, not
 * coerced, same as ffprobe's own "N/A" duration below (Fix round 1, item 2). Only ever called when
 * a video stream is known to exist, in which case ffprobe is expected to report real dimensions -
 * a missing value (never defaulted to 0) or a zero/negative one is refused rather than silently
 * accepted (Fix round 2, item 7). */
function positiveDimension(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x) || !Number.isInteger(x) || x <= 0) throw new Error("bad dimension");
  return x;
}

// A plain decimal, nothing else: no sign, no exponent, no hex, no surrounding text. ffprobe's own
// duration is always either this shape or the literal string "N/A" - never "0x10" or "" - so
// anything else is refused outright rather than coerced through Number(), which happily turns ""
// into 0 and "0x10" into 16 (Fix round 2, item 7).
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

export async function probe(runner: ProcessRunner, ffprobe: string, file: string, cwd: string, signal?: AbortSignal): Promise<ProbeResult> {
  const r = ensure(await runner.run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], {
    cwd, signal, timeoutMs: MINUTE, env: cleanEnv({}),
  }), "ffprobe could not read the video");
  // Every shape/range check below is wrapped in one try/catch so any failure - non-JSON, null, a
  // missing streams array, a wrong-typed or out-of-range field - takes the same single path, and
  // the message handed to the caller is always this fixed string, never anything built from
  // r.stdout/r.stderr: a hostile ffprobe answer must not be able to inject text into whatever
  // reads this error (Fix round 1, item 2).
  try {
    const j: unknown = JSON.parse(r.stdout);
    if (j === null || typeof j !== "object") throw new Error("not an object");
    const streams = (j as { streams?: unknown }).streams;
    if (!Array.isArray(streams)) throw new Error("no streams array");
    const isStream = (s: unknown): s is { codec_type?: unknown; width?: unknown; height?: unknown } => !!s && typeof s === "object";
    const v = streams.find((s) => isStream(s) && s.codec_type === "video") as { width?: unknown; height?: unknown } | undefined;
    const durationRaw = (j as { format?: { duration?: unknown } }).format?.duration;
    // ffprobe reports duration as a JSON string; "N/A" and absurdly large values (Number("1e400")
    // is Infinity) must be refused outright, never silently coerced to 0 or passed through. A
    // string must match PLAIN_DECIMAL after trimming, or it's refused outright (Fix round 2, item
    // 7) - Number(durationRaw) alone would accept "" (-> 0) and "0x10" (-> 16, JS's own hex
    // parsing), neither of which ffprobe would ever actually emit.
    const duration =
      typeof durationRaw === "number" ? durationRaw
      : typeof durationRaw === "string" && PLAIN_DECIMAL.test(durationRaw.trim()) ? Number(durationRaw.trim())
      : NaN;
    if (!Number.isFinite(duration) || duration < 0) throw new Error("bad duration");
    const width = v ? positiveDimension(v.width) : 0;
    const height = v ? positiveDimension(v.height) : 0;
    const audio = streams.some((s) => isStream(s) && s.codec_type === "audio");
    return { duration, width, height, video: !!v, audio };
  } catch {
    throw new VideoError("probe_unreadable", "ffprobe's answer about the video could not be read.");
  }
}
