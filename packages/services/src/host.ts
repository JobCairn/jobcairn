import type { BackgroundScheduler, Fetcher, MailAccount, MailProvider } from "@careeros/mail";
import type { AppInfo, UpdateStatus } from "@careeros/contract";
import type { VideoHost } from "./video.js";
import type { LockIds } from "@careeros/core";
import type { ClaudeHost } from "./claude/detect.js";
import type { ChromeHost } from "./chrome/service.js";
import type { SetupHost } from "./setup.js";

/**
 * OS secure storage (Keychain, DPAPI, libsecret). Values never travel to the renderer. Keys are
 * "ws.<workspace id>.<SecretName>" (see secrets.ts `secretKey`; a bare SecretName is the older unscoped form).
 * Features read secrets through `workspaceSecrets(ctx)`, never this store directly.
 */
export interface SecretStore {
  available(): boolean;
  has(key: string): boolean;
  /**
   * Null when the key simply holds nothing, or when `available()` is already false. Throws (a
   * `KeychainAccessError` in the real app-electron store) if a value exists but the OS denies the
   * decrypt itself - a one-off failure distinct from "not available", worth a retry. Any caller that
   * decrypts a secret for real use (an API key before a run, a mail password before sync/send) should
   * catch that and show its own "couldn't use the Keychain, try again" message, as SecretRow does for `set`.
   */
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /**
   * Relocates a stored value to a different key as-is (still encrypted on disk), without decrypting or
   * re-encrypting it. Lets a one-time migration (see secrets.ts `adoptUnscopedSecrets`) move an older save
   * into its new, workspace-scoped key without ever touching the OS Keychain - so it can't trigger its
   * "wants to access" prompt at launch. A no-op when `from` holds nothing.
   */
  move(from: string, to: string): void;
}
export interface AppState {
  lastWorkspace: string | null;
  recent: string[];
  /**
   * Per recent root: the workspace's id and the person's name as last seen, so a moved folder can be recognised
   * ("Locate…") and a missing one still shows a name. Kept only for roots in `recent`.
   */
  recentInfo?: Record<string, { id: string; name: string }>;
  /** Per workspace root: approval id -> digest, for the approvals this app created. Only these show "From you". */
  appApprovals?: Record<string, Record<string, string>>;
  /**
   * Per workspace root: approval id -> the digest the person approved, recorded when they press Approve (for
   * approvals from the app, Claude or the CLI alike). Send again needs the record to still match it, so a
   * process that can write to the workspace can't swap in an email the person never reviewed.
   */
  approvedDigests?: Record<string, Record<string, string>>;
  /** Per workspace root: each locked folder's identity ("dev:ino") while it was in place. See integrity.ts. */
  lockIds?: Record<string, LockIds>;
  /** Per workspace root: earlier identities of each locked folder, still locked by identity. See integrity.ts. */
  lockIdHistory?: Record<string, Partial<Record<import("@careeros/core").LockableDir, string[]>>>;
  /**
   * Per workspace root: where each drop box file the app added came from, keyed by its name in inbox/. `dev`/`ino`
   * pin the drop box copy, so a different file later given the same name never inherits Put back. Paths stay in main.
   */
  inboxOrigins?: Record<string, Record<string, InboxOrigin>>;
  /** In-app updates: check on launch and every few hours. Absent means on; false only after the person turns it off. */
  autoUpdate?: boolean;
}
export interface InboxOrigin { path: string; dev: number; ino: number }
export interface AppStateStore { read(): AppState; write(s: AppState): void }
export interface ShellHost {
  pickFolder(purpose: "create" | "open" | "legacy"): Promise<string | null>;
  pickFile(): Promise<string | null>;
  /** Shows the full address (and the note, if any) and opens it in the system browser only if the person agrees. */
  openExternal(url: string, note?: string): Promise<boolean>;
  showItemInFolder(absPath: string): void;
  /** Opens a checked document or media file in its default app (files.open). Optional: without it the viewer says so. */
  openPath?(absPath: string): Promise<void>;
  /**
   * Moves a file or folder to the system Trash (recoverable). Optional: without it the drop box can't remove files and
   * "Move to Trash" for an empty workspace says it isn't available. Services choose and check the path first.
   */
  trashItem?(absPath: string): Promise<void>;
  openClaudeDesktop(): Promise<boolean>;
  /** Puts text on the system clipboard (the prompt for Claude). */
  copyText(text: string): void;
  /**
   * Shows a save dialog with `name` suggested and writes `bytes` where the person chose. False when they cancel.
   * The path never leaves the main process. Optional so older shells still build; without it downloads say so.
   */
  saveFile?(name: string, bytes: Uint8Array, kind: "pdf" | "docx" | "md" | "txt"): Promise<boolean>;
}
/**
 * The app's updater (main only: electron-updater against GitHub Releases). `supported` is false in development and
 * test runs, which never check. The services keep the "check automatically" choice and pass it on with `setAuto`.
 */
export interface UpdateHost {
  supported: boolean;
  status(): UpdateStatus;
  /** Checks now; a found update downloads in the background. Resolves once the check itself is done. */
  check(): Promise<void>;
  /** Quits, installs the downloaded update and opens the app again. Only when the status is "ready". */
  install(): void;
  setAuto(on: boolean): void;
  /** Called whenever the status moves (the runtime pushes the "updates" change area). */
  onChange(cb: () => void): () => void;
}
/** Turns print-ready HTML into PDF bytes (Electron: a hidden, sandboxed window and printToPDF). */
export interface DocumentPrinter { toPdf(html: string): Promise<Uint8Array> }
/**
 * What mail needs from the shell. The Electron app supplies the real one; tests use fakeMailHost.
 * Everything that lives outside the workspace (the sync lock, the mail log) is kept per workspace,
 * keyed by its stable `workspace_id`, so two people's workspaces on one computer never share them.
 */
export interface MailHost {
  provider(account: MailAccount): MailProvider;
  /** https only, no cookies or referrer, at most 5 MB, never SVG (see fetchRemoteImage in @careeros/mail). */
  fetchImage(url: string): Promise<{ type: string; body: Buffer }>;
  /** This workspace's sync lock file, in user data (never in the workspace). */
  lockFile(workspaceId: string): string;
  /** Appends one already-redacted line to this workspace's mail log in user data (no id: the app-wide log). */
  log(line: string, workspaceId?: string): void;
  readLog(workspaceId?: string): string[];
  /** The command the OS scheduler runs: the app itself with fixed arguments. */
  backgroundCommand(workspace: string): { program: string; args: string[] };
}
export interface Host {
  secrets: SecretStore; state: AppStateStore; shell: ShellHost; info: AppInfo; now?: () => Date; printer?: DocumentPrinter;
  /** The Claude Code engine's process access (main only). Absent: the engine reports Claude Code as missing. */
  claude?: ClaudeHost;
  mail?: MailHost;
  /** Each workspace's own OS schedule for background mail sync (named after its workspace_id). */
  scheduler?: (workspaceId: string) => BackgroundScheduler;
  net?: { allowedHosts: string[] };
  video?: VideoHost;
  /** The person's home folder, where "Get started" makes the CareerOS folder. Absent: the OS home folder. */
  homeDir?: string;
  /** The computer account's full name, to prefill onboarding. "" when unknown. Optional. */
  userFullName?(): Promise<string>;
  /** The bundled example folder (fictional data) "Explore with an example" copies. Absent: that option fails plainly. */
  sampleDir?: string;
  /** Search in my Chrome (lane S): finds Chrome and the browser helper, opens Chrome's remote-control page. */
  chrome?: ChromeHost;
  /** Installs Claude Code, Node.js, Python and ffmpeg for the person, after a native confirm (setup.*). */
  setup?: SetupHost;
  /**
   * "Add a job": the guarded https fetcher (no cookies, no redirects followed, public addresses only) for applicant
   * systems' public job data. Absent: links to those systems ask for the ad's text instead.
   */
  jobFetch?: Fetcher;
  /** A system notification (a scheduled search finished). Absent: none is shown. */
  notify?(title: string, body: string): void;
  /** "Open JobCairn at login", so schedules run. Absent: not offered. */
  loginItem?: { get(): boolean; set(on: boolean): void };
  /** In-app updates (app.updates.*). Absent: the About dialog offers the download page only. */
  updates?: UpdateHost;
}
