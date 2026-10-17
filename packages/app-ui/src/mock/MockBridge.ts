import { demoFileUrl, mockOpenCheck, mockPreview, VIEWER_BINARIES, viewerDemoFiles } from "./viewer-demo";
import { MockNetwork } from "./network-demo";
import { isLockedKind, LOCKABLE_DIRS,
  ACTIONS, actionKey, actionPaths, actionStatusView, buildActionPrompt, claudeWrites, deriveTarget, nextVideoFolder, ownTarget, TEMPLATE_ONLY, videoFolderN,
  type ActionId, type ActionPrepared, type ActionStatusView, type ActionTarget, type FolderProbe, type Probe, type PromptInfo,
  defaultOptions, isNotRequested, optionsFor, optionValueOk, searchPrefsFrom, skillSuggestions, validateOptions, withSavedSearchOptions, type ComposeView, type OptionValue,
  applyJobQuery, withGhostFlags, compareSalary, jobCalendarEvent, offerOf, type CalendarKind, type OfferDetails, applyStep, buildSponsorRows, approvalDigestText, buildApplyPrompt, fileKind, gapsFrom, pickScore, homeSummary, isEligible, isSafeHttpsUrl, jobRowFromRecord,
  prioritiseSponsorship, validateArgs, checkLanguages, detectLanguageNeeds, spokenLanguages, RESEARCH_FILE, researchAge, isDefaultLength, VIDEO_LENGTH_PATH, videoLengthPath, type VideoTypeView,
  type UpdateStatus, type UpdateView,
  type AccessRequestView, type ActivityEntry, type AppInfo, type ApplyState, type ApprovalView, type CareerosBridge, type ChangeArea,
  type ChangeEvent, type ClaimLink, type DroppedFile, type FiledEntry, type FolderSummary, type InboxOverview, type Grant, type InboxItem, type InboxSuggestion, type InboxTarget, type JobDetail, classifyText, type DocKind,
  type JobFile, type JobQuery, type JobStatus, type JobSubdir, type LearnData, type LegacyPreview, type LockableDir, type LockProblemView, type PrivacyState,
  type SavedView, type SearchList, type SecretName, type SecretStatus, type SettingsChange, type SettingsData, type SettingsKind,
  cleanSchedule, nextRun, type ScheduleView, type SearchSchedule,
  type SponsorRow, type WorkRightsStatus, type WorkspaceSummary, type FolderSuggestion, type RecentWorkspace, CHANGE_AREAS,
  EXPORT_FORMATS, EXPORT_SOURCES, exportRel, exportSourceRel, isCalendarDate, type ExportFormat, type ExportSource, type ExportState,
  speakable, TTS_VOICES, voiceLabel, type TtsActivity, type TtsLang, type TtsOptions, type TtsPreviews, type TtsSpeakResult, type TtsStatus, type TtsVoice,
  DEFAULT_RESUME_STYLE, parseResume, parseResumeStyle, rewriteOptions, STUDIO_DIR, studioRewriteOptions, SUGGESTED_FOR, SUGGESTED_NAME,
  toPlainText, VERSION_EVERY_MS, visibleMarkdown, type ClaudeRunRequest, type DownloadResult, type ResumeCopy, type ResumeDownload, type ResumeState,
  type ResumeStyle, type SuggestionDecision, type VersionKind,
  guideState, isSkippableSetup, jobsToLearn, prefsMissing, learnEntries, skillGaps, mailRefToken, mailUrlFor,
  type GuideFacts, type GuideJob, type GuideState, type SetupStepId, type LearnHub, type LearnProgress, type ProgressMap,
  emptyTourState, sanitizeTourState, type TourId, type TourMark, type TourState,
  VARIANTS_DIR, type ResumeItemRef, type ResumeLibrary, type ResumeRef,
  adAddress, guessFromAd, jobAdKey, routeJobLink, scanWorkRights, type JobAddStatus, type JobAdded, type JobDraft, type JobDuplicate, type JobPreview, type JobPreviewResult,
  RESUME_FIELD_KEYS, RESUME_FIELD_PATHS, SUGGESTIONS_REL, type ResumeFieldKey, type ResumeFields, type ResumeFillState, type ResumeRead, type ResumeValues,
  type TargetSuggestions, compareBoardSites, type SearchRow, type TrashCheck, type TrashItem, type TrashTarget, type TrashTargetKind, isActiveRun,
  buildCompanyDetail, buildCompanyRows, COMPANY_SKIP, CONTACTS_FILE, readCompanyContacts, type CompanyFile,
  agencyActivity, agencyAddresses, agencyPatchArgs, agencyThreads, addRecruiterArgs, applyAgencyPatch, buildAgencyRows, localDate, parseAgencyLines, type AddRecruiterInput, type AgencyAddClean,
  type AgencyAddResult, type AgencyEmails, type AgencyImportResult, type AgencyPatch, type AgencyRecordView, type AgencyRow, type CompanyRow, type VideoListItem, type VideoSubjectArg,
  parseDraftSuggestion, RECRUITER_EMAIL_IDS, SUGGESTION_UNREADABLE, type DraftSuggestion,
} from "@careeros/contract";
import { DEMO_SCORE, DEMO_SCORE_MD } from "../score/demo";
import { ALEX_LONG_RESUME, ALEX_RESUME, mockRewrite, RESUME_JOB } from "./resume-fixture";
import { mockEmailDraft } from "./email-demo";
import fixtureJson from "./alex-fixture.json";
import { MockClaude, type MockClaudeOptions } from "./claude-mock";
import { withTableDemo } from "./demo-tables";
import { withManyRows } from "./demo-rows";
import type { ApprovalRecord, Fixture, FixtureJob } from "./fixture-types";
import { createVideoMock } from "./video-mock";
import { createSetupMock, type SetupMockOptions } from "./setup-mock";
import { applyLearnDemo } from "./learn-demo";
import { createMockMail, type MockMail, type MockMailHooks } from "./mail-mock";
import { PRODUCT_NAME } from "@careeros/brand/identity";

/** An object shaped like `target()` whose functions (nested ones too) always call the current target's. */
function delegate<T extends object>(target: () => T): T {
  const wrap = (get: () => Record<string, unknown>, shape: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(shape).map(([k, v]) => [k,
      typeof v === "function" ? (...args: unknown[]) => (get()[k] as (...a: unknown[]) => unknown)(...args)
        : v && typeof v === "object" ? wrap(() => get()[k] as Record<string, unknown>, v as Record<string, unknown>) : v]));
  return wrap(target as () => Record<string, unknown>, target() as Record<string, unknown>) as T;
}

/** Matches services tts-runner: the voice's tools install from Settings > Voice. */
const SETUP_AGAIN = "Install Python 3.11 to 3.14 in Settings > Voice.";

export interface MockOptions {
  /** What "Choose a file" returns (default: a fictional cover letter in Downloads). */
  pickFile?: string;
  now?: Date; fixture?: Fixture; workspaceOpen?: boolean; inbox?: string[]; secretStoreAvailable?: boolean; activity?: ActivityEntry[];
  /** Fictional text for drop box files, so the mock classifies them by content like main does. */
  inboxTexts?: Record<string, string>;
  /** Drop box Ask Claude: "auto" answers after a short wait (the preview); "manual" waits for finishInboxAsk (tests). */
  inboxClaude?: "auto" | "manual";
  videoToolsOk?: boolean;
  /** The tools on this fictional Mac (Claude Code, Node.js, Python, ffmpeg) and how installs behave. */
  setup?: SetupMockOptions;
  /** Whether Claude Desktop opens on request (default true). */
  claudeDesktop?: boolean;
  /** Whether putting the prompt on the clipboard works (default true). */
  clipboard?: boolean;
  /** The Claude Code engine's state (default: set up and ready). */
  claudeEngine?: MockClaudeOptions;
  /** The drop box's filing history, newest first. */
  filed?: FiledEntry[];
  /** Read aloud: which engine the mock reports (default "supertonic"). */
  ttsEngine?: TtsStatus["engine"];
  /** Read aloud: how long each fake synthesis takes, so "Preparing voice…" shows (default 0 in tests, 900 ms in the dev preview). */
  ttsDelayMs?: number;
  /** Read aloud: whether voice previews already exist (default false). */
  ttsPreviews?: boolean;
  /** Read aloud: Supertonic is installed but its model isn't downloaded yet (the macOS voice reads until then). */
  ttsNeedsDownload?: boolean;
  /** Read aloud: Supertonic itself isn't installed yet (no venv at all). Settings > Voice offers the in-app install. */
  ttsNeedsInstall?: boolean;
  /** Seed Alex's tailored resume and Claude's suggested rewrite for the Acme Corp job (default: on in the dev preview, off in tests). */
  resumeDemo?: boolean;
  /** Adds one file of each kind (notes, a PDF, a Word file, an image, a Keynote file) to the Acme Corp job for the file viewer. */
  viewerDemo?: boolean;
  /** What the save dialog answers for downloads (default true: saved). */
  saveDialog?: boolean;
  /** Richer fictional learning data for the dev preview: skills in the ads, a scored job, guides with progress. */
  learnDemo?: boolean;
  /** Mail: whether a fictional Gmail account is connected (default true). */
  mailConnected?: boolean;
  /** Mail (`?maildemo`, dev preview only): more fictional mail, and email bodies served by the vite dev server so the reader shows them. */
  mailDemo?: boolean;
  /** Mail: approving an email send ends "not sure", so Mark as sent and Send again can be tried (default false). */
  mailSendUnsure?: boolean;
  /** What "Get started" finds (default: a new ~/CareerOS, no account name). `existing: true` opens it instead. */
  suggestion?: Partial<FolderSuggestion>;
  /** Start with the example open ("Explore with an example"), so the banner shows (default false). */
  isSample?: boolean;
  /**
   * The folder calls (`workspace.suggest`, `workspace.start`, `workspace.openSample`). Default true; false acts like a
   * bridge that predates them, so onboarding's fallback (the folder picker) can be tested.
   */
  folderApi?: boolean;
  /** Shorthands for `suggestion.existing` and `suggestion.name`. */
  suggestExisting?: boolean;
  suggestName?: string;
  /**
   * Other workspaces in the switcher's list, after the open one (default: one, "Sam Sample" in "CareerOS Sam").
   * `available: false` acts like a folder that was moved or deleted.
   */
  otherWorkspaces?: { name: string; folder: string; available?: boolean; parent?: string; companies?: number; empty?: boolean; created?: string }[];
}

const MOCK_HOME = "/fictional/alex-example";
/** One workspace in the mock's switcher list. `name` is kept for closed ones (the open one reads its profile). */
interface MockSpace {
  key: string; root: string; folder: string; name: string; available: boolean; isSample: boolean;
  companies?: number; empty?: boolean; created?: string;
}

/**
 * A silent mono WAV as a data: URL, about as long as a person would take to say `text` (2.6 words a second,
 * 1 to 8 seconds). The mock has no voice; the player still sees real audio with a real duration.
 */
export function silentWavUrl(text: string): string {
  const rate = 4000;
  const secs = Math.min(8, Math.max(1, text.split(/\s+/).filter(Boolean).length / 2.6));
  const n = Math.round(rate * secs);
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const ascii = (at: number, t: string) => { for (let i = 0; i < t.length; i++) buf[at + i] = t.charCodeAt(i); };
  ascii(0, "RIFF"); dv.setUint32(4, 36 + n, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); ascii(36, "data"); dv.setUint32(40, n, true);
  buf.fill(128, 44);
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

interface MockResume {
  rel: string; md: string; style: ResumeStyle; savedAt: string;
  versions: { id: string; kind: VersionKind; at: string; text: string }[];
}

/** 64 hex characters from FNV-1a passes, standing in for the services' SHA-256 of the Markdown. */
export function mockHash(text: string): string {
  let out = "";
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const MOCK_FOLDERS = [
  { id: "resumes", label: "Resumes", rel: "me/resumes" }, { id: "history", label: "Work history", rel: "me/history" },
  { id: "projects", label: "Projects", rel: "me/projects" }, { id: "education", label: "Education", rel: "me/education" },
  { id: "identity", label: "Identity documents", rel: "me/identity" }, { id: "employment", label: "Employment records", rel: "me/employment" },
  { id: "companies", label: "Companies and jobs", rel: "companies" }, { id: "knowledge", label: "Knowledge", rel: "knowledge" },
  { id: "learning", label: "Learning", rel: "learning" },
];
const DEFAULT_INBOX = ["acme-corp-cover-letter.pdf", "Visa_Grant_Notice.pdf"];
const DOWNLOADS = "/fictional/alex-example/Downloads";
/** The fictional ad an applicant-system link "returns" in the preview. */
const MOCK_AD_TEXT = [
  "Applied AI Engineer", "", "Example Labs builds tools that help small teams write better documents.", "",
  "What you'll do", "- Build and ship LLM features in our TypeScript product", "- Evaluate prompts and retrieval quality", "",
  "About you", "- 3+ years building production software", "- Experience with Python or TypeScript", "",
  "Visa sponsorship is available for the right candidate.",
].join("\n");
/**
 * The fictional ad a job board link "reads" in the mock Chrome (`?chrome`), laid out as LinkedIn shows it: company,
 * title, then "Place · posted · applicants" and the pills. Read as LinkedIn whichever board the link names.
 */
const MOCK_BOARD_AD = [
  "Acme Corp", "Share", "Senior AI Engineer", "Sampletown NSW · 3 days ago · 12 people clicked apply", "Hybrid", "Full-time", "", "About the job",
  "Join Acme Corp's AI team to build retrieval and agent features.", "",
  "Requirements", "- Strong Python", "- Experience shipping LLM features", "",
  "You must have full working rights in Australia.",
].join("\n");
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * A stand-in for the services' SHA-256: 64 hex characters from four FNV-1a passes. Not cryptographic;
 * it only has to change when the record changes, like the real digest.
 */
export function mockDigest(a: ApprovalRecord): string {
  const text = approvalDigestText(a);
  let out = "";
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

export function loadFixture(): Fixture {
  return clone(fixtureJson as unknown as Fixture);
}

// Segments that would let a dotted path reach Object.prototype instead of an own property.
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (UNSAFE_PATH_SEGMENTS.has(k)) return undefined;
    if (o !== null && typeof o === "object" && Object.hasOwn(o, k)) return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some((k) => UNSAFE_PATH_SEGMENTS.has(k))) throw new Error(`${path} can't be changed here`);
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    const next = Object.hasOwn(o, k) ? o[k] : undefined;
    if (typeof next !== "object" || next === null) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys.at(-1)!] = value;
}

export class MockBridge implements CareerosBridge {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly opened: string[] = [];
  readonly revealed: string[] = [];
  /** Files "opened in their default app" (files.open). */
  readonly openedFiles: string[] = [];
  /** Test hook: every prompt put on the clipboard. */
  readonly copied: string[] = [];
  private f: Fixture;
  /** The fixture as first loaded: "Explore with an example" resets to it. */
  private readonly pristine: Fixture;
  private sample: boolean;
  private readonly suggestion: FolderSuggestion;
  private now: Date;
  private isOpen: boolean;
  private pickFile: string | undefined;
  private inboxNames: string[];
  /** Drop box files the app added, and the folder name each came from (services keep the path in main). */
  private inboxFrom = new Map<string, string>();
  private inboxTexts = new Map<string, string>();
  private inboxAsks = new Map<string, { state: "running" | "done" | "failed"; error?: string; suggestion?: InboxSuggestion }>();
  private inboxClaudeMode: "auto" | "manual" = "manual";
  private views: SavedView[] = [];
  private exportsMade = new Map<string, { size: number; at: string }>();
  private locked: LockableDir[];
  private grants: Grant[] = [];
  private problems: LockProblemView[] = [];
  private activity: ActivityEntry[];
  /** Secrets per workspace (by switcher key), like the services' "ws.<id>.<name>" keys. */
  private secretSets = new Map<string, Set<SecretName>>();
  /** The switcher's list, most recent first, and each closed workspace's data. */
  private spaces: MockSpace[] = [];
  /** Folders "moved to the Trash" (folder names). */
  trashed: string[] = [];
  private currentKey = "";
  private stash = new Map<string, Fixture>();
  private spaceSeq = 0;
  private secretsAvailable: boolean;
  private appFiles = new Map<string, JobFile[]>();
  private listeners = new Set<(e: ChangeEvent) => void>();
  private seq = 0;
  private videoMockHost = {
    iso: () => this.iso(), emit: (...a: ChangeArea[]) => this.emit(...a),
    rec: <T,>(m: string, a: unknown[], fn: () => T) => this.rec(m, a, fn), toolsOk: true, customTypes: [] as VideoTypeView[],
  };
  /** Test hook: a custom video type in the workspace's settings/video-types. */
  seedVideoType(t: Omit<VideoTypeView, "origin">): void { this.videoMockHost.customTypes.push({ ...t, origin: "workspace" }); }
  private videoMock = createVideoMock(this.videoMockHost);
  private setupMock: ReturnType<typeof createSetupMock>;
  get setup(): CareerosBridge["setup"] { return this.setupMock.api; }
  /** Test hooks for the Setup cards. */
  finishSetupInstall(ok = true): void { this.setupMock.finishInstall(ok); }
  setSetupBrew(v: boolean): void { this.setupMock.setBrew(v); }
  setSetupProgress(line: string): void { this.setupMock.setProgress(line); }
  // Delete goes through the trash, like main (trash.ts), so it can be undone.
  private videoApi: CareerosBridge["video"] = { ...this.videoMock.api, delete: (folder: string) => this.rec("video.delete", [folder], () => this.trashMove([{ kind: "video", folder }])[0]!) };
  get video(): CareerosBridge["video"] { return this.videoApi; }
  /** Test hook: what the chat's start_video tool does in the real app. */
  /** A script that failed its format check (the video review's worst case), for tests and `?video=broken`. */
  simulateBrokenScript(folder: string): void { this.videoMock.breakScript(folder); }
  /** Making the video stopped at the video check, after the script skipped review. */
  simulateStoppedVideo(folder: string, reason?: string): void { this.videoMock.stopAtCheck(folder, reason); }
  /** A video run that stays in progress (preview of the progress panel). */
  simulateVideoRun(folder: string, kind: "writing" | "building"): void { this.videoMock.holdRun(folder, kind); }
  simulateVideoItem(folder: string, patch: Partial<VideoListItem>): void { this.videoMock.patchItem(folder, patch); }
  simulateLegacyVideo(folder: string, type: string, subject: VideoSubjectArg, at: string): void { this.videoMock.addLegacy(folder, type, subject, at); }
  simulateVideoIntent(type: string, subject: string, target?: ActionTarget): void { this.videoMock.setIntent(type, subject, target); }
  /** Ids (and digests) of approvals this bridge created itself, like the services' app state. */
  private mine = new Map<string, string>();
  private claudeDesktop: boolean;
  private clipboardWorks: boolean;
  /** Action key -> when it was asked for and (videos) the folder asked for, like the services' .careeros/actions notes. */
  private actionRequests = new Map<string, { at: string; folder: string }>();
  /** Action key -> the options last chosen in the request composer, like the services' .careeros/requests sidecars. */
  readonly savedOptions = new Map<string, Record<string, OptionValue>>();
  /** Path -> modified time of files Claude "wrote" in tests. */
  private actionOutputs = new Map<string, string>();
  /** What the drop box filed, newest first (the services read inbox/_filed.md). */
  private filed: FiledEntry[];
  private ttsEngine: TtsStatus["engine"];
  private ttsDelayMs: number;
  private ttsPreviewsMade: boolean;
  private ttsPreviewVoices = new Set<string>();
  private ttsNeedsDownload: boolean;
  private ttsNeedsInstall: boolean;
  private ttsCache = new Set<string>();
  private ttsPending = new Map<string, () => void>();
  private resumeDocs = new Map<string, MockResume>();
  /** General resume versions (resume-variants/<variant>/variant.json), by slug. */
  private variantMeta = new Map<string, { name: string; created_at: string }>();
  /** Test hook: files "saved" through the download dialog. */
  readonly downloads: { name: string; format: ResumeDownload; text: string }[] = [];
  private saveDialog: boolean;
  /** Learn progress sidecar and file dates, like .careeros/learn-progress.json and file mtimes. */
  private learnProgress: ProgressMap = {};
  private learnDates: Record<string, string> = {};
  private guideDismissed = false;
  /** Set up steps the person chose to skip, like `skipped` in .careeros/guide.json. */
  private guideSkipped: SetupStepId[] = [];
  /** The open workspace's mail; each workspace keeps its own (account, messages, drafts), like the services. */
  private mailMock: MockMail;
  private mailStash = new Map<string, MockMail>();
  private mailHooks!: Omit<MockMailHooks, "connected" | "empty">;
  private mailSendUnsure = false;
  /** Always calls the open workspace's mail, so a switch never shows another workspace's account or messages. */
  readonly mail: CareerosBridge["mail"];
  /** Guided tours, like .careeros/tour.json. */
  private tourState: TourState = emptyTourState();
  /** Like services welcomeTour: a workspace onboarding just made offers Home's tour once. */
  private welcome(): void { this.tourState = { ...this.tourState, welcome: true }; }

  constructor(opts: MockOptions = {}) {
    this.setupMock = createSetupMock({
      iso: () => this.iso(), emit: (...a: ChangeArea[]) => this.emit(...a),
      rec: <T,>(m: string, a: unknown[], fn: () => T) => this.rec(m, a, fn), recAsync: <T,>(m: string, a: unknown[], fn: () => Promise<T>) => this.recAsync(m, a, fn),
      // Like main: Claude Code installed means the engine's next check finds it.
      installed: (id) => { if (id === "claude-code") this.claudeSim.opts.cli = "ok"; },
    }, opts.setup);
    this.f = clone(opts.fixture ?? (fixtureJson as unknown as Fixture));
    if (opts.learnDemo) {
      const demo = applyLearnDemo(this.f);
      this.learnProgress = demo.progress;
      this.learnDates = demo.dates;
    }
    // After the learn demo, so "Explore with an example" keeps its guides (`?onboarding&learn`).
    this.pristine = clone(this.f);
    this.sample = opts.isSample ?? false;
    this.suggestion = {
      dir: `${MOCK_HOME}/${PRODUCT_NAME}`, display: `~/${PRODUCT_NAME}`, existing: opts.suggestExisting ?? false, name: opts.suggestName ?? "", ...opts.suggestion,
    };
    this.now = opts.now ?? new Date("2026-01-15T09:00:00.000Z");
    this.isOpen = opts.workspaceOpen ?? true;
    this.pickFile = opts.pickFile;
    this.inboxNames = [...(opts.inbox ?? DEFAULT_INBOX)];
    for (const [n, t] of Object.entries(opts.inboxTexts ?? {})) this.inboxTexts.set(n, t);
    this.inboxClaudeMode = opts.inboxClaude ?? "manual";
    this.locked = [...this.f.workspace.locked];
    this.activity = clone(opts.activity ?? []);
    this.secretsAvailable = opts.secretStoreAvailable ?? true;
    this.videoMockHost.toolsOk = opts.videoToolsOk ?? true;
    this.claudeDesktop = opts.claudeDesktop ?? true;
    this.clipboardWorks = opts.clipboard ?? true;
    this.claudeSim.opts = { ...opts.claudeEngine };
    this.filed = clone(opts.filed ?? [{ at: "2026-01-11T09:00:00.000Z", name: "alex-example-resume.pdf", to: "me/resumes/alex-example-resume.pdf", note: "Sample resume" }]);
    this.ttsEngine = opts.ttsEngine ?? "supertonic";
    // The dev preview pretends synthesis takes a moment, so "Preparing voice…" can be seen; tests default to none.
    this.ttsDelayMs = opts.ttsDelayMs ?? (import.meta.env?.MODE === "test" ? 0 : 900);
    this.ttsPreviewsMade = opts.ttsPreviews ?? false;
    this.ttsNeedsDownload = opts.ttsNeedsDownload ?? false;
    this.ttsNeedsInstall = opts.ttsNeedsInstall ?? false;
    if (this.ttsNeedsDownload || this.ttsNeedsInstall) this.ttsEngine = "macos_say";
    this.saveDialog = opts.saveDialog ?? true;
    if (opts.folderApi === false) {
      for (const m of ["suggest", "openSample", "start", "recent", "switchTo", "forget", "startNew", "trash", "locate", "addRecent"] as const) delete (this.workspace as Partial<typeof this.workspace>)[m];
    }
    // A first run (no workspace open) has an empty list unless the test or preview gives one.
    if (this.isOpen) this.track();
    if (this.sample && this.spaces[0]) this.spaces[0].isSample = true;
    for (const o of opts.otherWorkspaces ?? (this.isOpen ? [{ name: "Sam Sample", folder: `${PRODUCT_NAME} Sam` }] : [])) {
      this.spaces.push({
        key: this.nextKey(), root: `${o.parent ? `${MOCK_HOME}/${o.parent}` : MOCK_HOME}/${o.folder}`, folder: o.folder, name: o.name, available: o.available ?? true, isSample: false,
        companies: o.companies, empty: o.empty, created: o.created,
      });
    }
    // The `?data=empty` preview has no jobs, so there's no Acme Corp job to seed a resume for.
    if (opts.resumeDemo && this.f.jobs.some((j) => j.job.company_slug === RESUME_JOB.slug && j.job.id === RESUME_JOB.id)) {
      this.seedResume(RESUME_JOB.slug, RESUME_JOB.id, ALEX_RESUME, mockRewrite(ALEX_RESUME));
      // A long general version: three pages, several roles at one place, items and an empty section.
      this.seedVariant("long-version", "Long version", ALEX_LONG_RESUME);
    }
    // Preview only: a company research note, so a company page has a file to open (fictional).
    if (opts.viewerDemo) this.f.texts["companies/example-labs/research.md"] ??= "# Example Labs\n\nA fictional company profile for the preview.\n\n## What they do\n\nExample Labs builds retrieval tools for internal search.\n\n## Size and locations\n\nAbout 120 people. Offices in Brisbane and Sydney.\n\n## Tech stack\n\nPython, TypeScript, Postgres.\n";
    if (opts.viewerDemo) this.f.jobs.find((j) => j.job.company_slug === RESUME_JOB.slug && j.job.id === RESUME_JOB.id)?.job.files.push(...viewerDemoFiles(this.f.texts));
    this.mailSendUnsure = opts.mailSendUnsure ?? false;
    this.mailHooks = {
      rec: (m, a, fn, v) => this.rec(m, a, fn, v),
      example: () => this.sample,
      emit: (...areas) => this.emit(...areas),
      now: () => this.iso(),
      jobName: (slug, id) => {
        const j = this.f.jobs.find((x) => x.job.company_slug === slug && (!id || x.job.id === id));
        return { company: j?.company.name ?? (this.f.agencies ?? []).find((a) => a.slug === slug)?.name ?? slug, title: id && j ? j.job.title : "", apply_via: id && j ? j.job.apply_via : "" };
      },
      event: (slug, id, event, note) => this.event(this.find(slug, id), event, note),
      view: (a) => this.view(a),
      remember: (a) => { this.mine.set(a.id, mockDigest(a)); },
      secureStorage: () => this.secretsAvailable,
      sendUnsure: this.mailSendUnsure,
      file: (rel) => (Object.hasOwn(this.f.texts, rel) ? { text: this.f.texts[rel]!, at: this.actionOutputs.get(rel) ?? this.iso() } : null),
      recruiter: (slug) => (this.f.companies.find((c) => c.slug === slug) as { recruiter?: { name: string; email: string } } | undefined)?.recruiter ?? null,
      linkAgency: (slug, value) => {
        const a = (this.f.agencies ?? []).find((x) => x.slug === slug);
        if (!a) throw new Error("That recruiter isn't in this workspace.");
        if (!(a.email_match ?? []).includes(value)) a.email_match = [...(a.email_match ?? []), value];
        a.timeline.push({ at: this.iso(), event: "Email linked", note: value });
        return { name: a.name };
      },
    };
    this.mailMock = createMockMail({ ...this.mailHooks, connected: opts.mailConnected ?? true, demo: !!opts.mailDemo });
    // The dev server's mock-mail-frames plugin answers /__mock-mail/<token>, so the sandboxed frame has a body to show.
    if (opts.mailDemo) this.mailUrl = (ref: string): string => `${window.location.origin}/__mock-mail/${mailRefToken(ref)}`;
    this.mail = delegate(() => this.mailMock.api);
  }

  /** Puts away the workspace being left's mail and brings back (or starts, not connected) the next one's. */
  private swapMail(fromKey: string): void {
    this.mailStash.set(fromKey, this.mailMock);
    this.mailMock = this.mailStash.get(this.currentKey) ?? createMockMail({ ...this.mailHooks, connected: false, empty: !this.sample && this.f.jobs.length === 0 });
    this.mailStash.delete(this.currentKey);
  }

  /** Every approval: the fixture's and the email sends this bridge proposed. */
  private allApprovals(): ApprovalRecord[] { return [...this.f.approvals, ...this.mailMock.approvals]; }

  // ---- helpers -------------------------------------------------------------
  // Validates with the same `validateArgs` table the real IPC transport uses, so a screen
  // that mis-calls the bridge (bad format, non-https link, a stray control character) sees
  // the same rejection against the mock as it would against the real shell. `validateAs`
  // lets a caller validate the real argument (e.g. an unredacted secret) while `args` is
  // what gets recorded in `calls` — so a secret value is never logged, but is still checked.
  private rec<T>(method: string, args: unknown[], fn: () => T, validateAs: unknown[] = args): Promise<T> {
    this.calls.push({ method, args: clone(args) });
    try {
      validateArgs(method, validateAs);
      return Promise.resolve(clone(fn()));
    } catch (e) { return Promise.reject(e); }
  }
  /** rec for a call that waits on something (a fictional read in the mock Chrome). */
  private recAsync<T>(method: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    this.calls.push({ method, args: clone(args) });
    try { validateArgs(method, args); } catch (e) { return Promise.reject(e); }
    return fn().then(clone);
  }
  private nextKey(): string { return (++this.spaceSeq).toString(16).padStart(16, "0"); }
  /** Puts the open folder at the top of the switcher's list (like main's app state). */
  private track(): void {
    const before = this.currentKey;
    this.trackOnly();
    // Not on the first call (the constructor makes the first workspace's mail itself).
    if (before && before !== this.currentKey && this.mailMock) this.swapMail(before);
  }
  private trackOnly(): void {
    const root = this.f.workspace.root;
    let s = this.spaces.find((x) => x.root === root);
    if (!s) s = { key: this.nextKey(), root, folder: root.split("/").pop() ?? root, name: "", available: true, isSample: false };
    this.spaces = [s, ...this.spaces.filter((x) => x !== s)].slice(0, 10);
    this.currentKey = s.key;
  }
  /** Leaves the open workspace: keeps its data and name for later, and stops its Claude runs (main does the same). */
  private leave(): void {
    const cur = this.spaces.find((x) => x.key === this.currentKey);
    if (cur && this.isOpen) { cur.name = String(getPath(this.f.profile, "contact.name") ?? ""); cur.isSample = this.sample; this.stash.set(cur.key, this.f); }
    this.claudeSim.cancelActive();
  }
  /** A new, empty workspace for `name`. */
  private emptyWorkspace(root: string, name: string): Fixture {
    const f = clone(this.pristine);
    Object.assign(f, { jobs: [], companies: [], searches: [], approvals: [], requests: [], employers: [] });
    f.workspace.root = root;
    setPath(f.profile, "contact.name", name);
    return f;
  }
  private secretsHere(): Set<SecretName> {
    let s = this.secretSets.get(this.currentKey);
    if (!s) { s = new Set(); this.secretSets.set(this.currentKey, s); }
    return s;
  }
  private recentList(): RecentWorkspace[] {
    const rows = this.spaces
      .filter((s) => !s.isSample || (this.isOpen && s.key === this.currentKey))
      .map((s): RecentWorkspace & { root: string } => {
        const current = this.isOpen && s.key === this.currentKey;
        const f = current ? this.f : this.stash.get(s.key);
        const companies = s.available ? (f ? f.companies.length : s.companies ?? 0) : null;
        return {
          key: s.key, root: s.root, name: current ? String(getPath(this.f.profile, "contact.name") ?? "") : s.name, folder: s.folder, place: s.folder,
          isSample: current ? this.sample : s.isSample, current, available: s.available, problem: s.available ? "" : "missing",
          companies, created: s.available ? s.created ?? "2026-01-05" : "",
          empty: s.available && !(current ? this.sample : s.isSample) && (f ? !f.companies.length && !f.jobs.length : s.empty ?? false),
        };
      });
    const label = (r: RecentWorkspace) => `${r.name.trim().toLowerCase()}\0${r.folder.toLowerCase()}`;
    for (const r of rows) {
      if (rows.filter((o) => label(o) === label(r)).length < 2) continue;
      const dir = r.root.slice(0, r.root.lastIndexOf("/"));
      r.place = `${dir === MOCK_HOME ? "Home folder" : dir.split("/").pop()} › ${r.folder}`;
    }
    return rows.map(({ root: _root, ...r }) => r).sort((a, b) => Number(b.current) - Number(a.current));
  }
  private emit(...areas: ChangeArea[]): void { for (const l of [...this.listeners]) l({ areas }); }
  private iso(): string { return this.now.toISOString(); }
  private status(): WorkRightsStatus { return (getPath(this.f.profile, "work_rights.status") as WorkRightsStatus) ?? "unknown"; }
  private rows() {
    // Languages as main reads them (services languages.ts): only a blocker or a warning marks a row.
    const have = spokenLanguages(getPath(this.f.profile, "languages"));
    return this.f.jobs.map((j) => {
      const row = jobRowFromRecord(j.job, j.company.name, isEligible(this.status(), j.job.work_rights.label));
      const lang = have.length ? checkLanguages(detectLanguageNeeds(j.description), have) : null;
      return lang && lang.verdict !== "unknown" ? { ...row, lang } : row;
    });
  }
  private find(slug: string, id: string): FixtureJob {
    const j = this.f.jobs.find((x) => x.job.company_slug === slug && x.job.id === id);
    if (!j) throw new Error(`no job ${slug}/${id}`);
    return j;
  }
  private summary(): WorkspaceSummary {
    return { root: this.f.workspace.root, name: String(getPath(this.f.profile, "contact.name") ?? ""), dataVersion: this.f.workspace.dataVersion, migrated: [], indexSkipped: 0, isSample: this.sample };
  }
  private event(j: FixtureJob, event: string, note = ""): void { j.job.timeline.push({ at: this.iso(), event, note }); }
  private setJobStatus(j: FixtureJob, status: JobStatus, note: string): void { j.job.status = status; this.event(j, `Status: ${status}`, note); }
  private detail(j: FixtureJob): JobDetail {
    const base = `companies/${j.job.company_slug}/jobs/${j.job.id}`;
    const listed: JobFile[] = j.job.files.map((fr) => ({
      path: fr.path, rel: `${base}/${fr.path}`, label: fr.label, at: fr.at, exists: true,
      size: this.f.texts[`${base}/${fr.path}`]?.length ?? VIEWER_BINARIES[`${base}/${fr.path}`]?.size ?? null, kind: fileKind(fr.path),
    }));
    return {
      job: j.job, company: j.company, description: j.description, scoreReport: this.f.texts[`${base}/score.md`] ?? "",
      files: [...listed, ...(this.appFiles.get(`${j.job.company_slug}/${j.job.id}`) ?? [])], gaps: gapsFrom(j.job),
      eligible: isEligible(this.status(), j.job.work_rights.label), score: this.score(base, j),
      salaryBenchmark: compareSalary(jobRowFromRecord(j.job, j.company.name, true), this.rows()),
      language: checkLanguages(detectLanguageNeeds(j.description), spokenLanguages(getPath(this.f.profile, "languages"))),
    };
  }
  private score(base: string, j: FixtureJob): JobDetail["score"] {
    let json: unknown = null;
    try { json = JSON.parse(this.f.texts[`${base}/score.json`] ?? "null"); } catch { json = null; }
    return pickScore({ json, md: this.f.texts[`${base}/score.md`] ?? "", timeline: j.job.timeline, scores: j.job.scores });
  }
  private suggest(name: string): InboxSuggestion {
    const t = name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, " ");
    if (/\b(visa|grant)\b/.test(t)) return { target: { kind: "me", dir: "identity", sub: "visa" }, reason: "The name mentions a visa.", confidence: "high" };
    if (/\bpassport\b/.test(t)) return { target: { kind: "me", dir: "identity" }, reason: "The name looks like an identity document.", confidence: "high" };
    const j = this.f.jobs.find((x) => ` ${t} `.includes(` ${x.job.company_slug.replace(/-/g, " ")} `));
    if (j) {
      const subdir: JobSubdir = /\b(cover|letter|resume|cv|answers)\b/.test(t) ? "application" : "";
      return { target: { kind: "job", company_slug: j.job.company_slug, id: j.job.id, subdir }, reason: `The name mentions ${j.company.name}.`, confidence: "high" };
    }
    if (/\b(cv|resume)\b/.test(t)) return { target: { kind: "me", dir: "resumes" }, reason: "The name looks like a resume.", confidence: "medium" };
    return { target: null, reason: "No rule matched. Choose a folder.", confidence: "low" };
  }
  /** Like services inbox-smart: name rules, then the file's (fictional) text, then Claude's answer. */
  private inboxItems(): InboxItem[] {
    return this.inboxNames.map((name) => {
      const from = this.inboxFrom.get(name);
      const byName: InboxSuggestion = { ...this.suggest(name), by: "name" };
      const text = this.inboxTexts.get(name);
      const g = text ? classifyText(text) : null;
      let suggestion = byName;
      let kind: DocKind | undefined = byName.target?.kind === "me" && byName.target.dir === "identity" ? "identity" : byName.target?.kind === "me" && byName.target.dir === "resumes" ? "resume" : undefined;
      let job: InboxItem["job"];
      if (g && g.kind !== "other") {
        kind = g.kind;
        const found = this.f.jobs.find((j) => (g.company ?? text!).toLowerCase().includes(j.company.name.toLowerCase()));
        const target: InboxTarget | null = g.kind === "resume" ? { kind: "me", dir: "resumes" } : g.kind === "identity" ? { kind: "me", dir: "identity" } : g.kind === "employment" ? { kind: "me", dir: "employment" }
          : found ? { kind: "job", company_slug: found.job.company_slug, id: found.job.id, subdir: g.kind === "cover_letter" ? "application" : g.kind === "interview_notes" ? "interview" : "" } : null;
        const reason = g.kind === "job_ad" && !found ? `Looks like a job ad${g.company ? ` from ${g.company}` : ""}. Add it as a job, or choose a folder.` : g.reason;
        suggestion = { target, reason, confidence: target || g.kind === "job_ad" ? g.confidence : "low", by: "content" };
        if (g.kind === "job_ad") job = { company: g.company, title: g.title };
      }
      const locked = kind === "identity" || kind === "employment" || (suggestion.target?.kind === "me" && ["identity", "employment"].includes(suggestion.target.dir));
      const ask = this.inboxAsks.get(name);
      if (ask?.state === "done" && ask.suggestion) suggestion = ask.suggestion;
      const askable = !locked && kind !== "job_ad" && (suggestion.confidence === "low" || !suggestion.target) && ask?.state !== "running";
      return {
        name, size: 2048, suggestion, ...(from ? { from } : {}), ...(kind ? { kind } : {}), ...(job ? { job } : {}), askable,
        ...(ask ? { claude: { state: ask.state, ...(ask.error ? { error: ask.error } : {}) } } : {}),
      };
    });
  }

  /** Tests: Claude's answer for a file Ask Claude is running on (a suggestion, or an error). */
  finishInboxAsk(name: string, answer: InboxSuggestion | { error: string }): void {
    if ("error" in answer) this.inboxAsks.set(name, { state: "failed", error: answer.error });
    else this.inboxAsks.set(name, { state: "done", suggestion: { ...answer, by: "claude" } });
    this.emit("inbox");
  }
  private activeGrants(): Grant[] { return this.grants.filter((g) => g.until > this.iso()); }
  /** The fixture's texts, plus a drop box file's (fictional) text so the viewer can show it. */
  private viewerTexts(rel: string): Record<string, string> {
    const name = rel.startsWith("inbox/") ? rel.slice("inbox/".length) : "";
    if (!name || !this.inboxNames.includes(name) || /\.(pdf|docx?|png|jpe?g)$/i.test(name)) return this.f.texts;
    return { ...this.f.texts, [rel]: this.inboxTexts.get(name) ?? `${name}\n\nA fictional file in the drop box.` };
  }
  private lockedNow(): LockableDir[] { const open = new Set(this.activeGrants().map((g) => g.folder)); return this.locked.filter((d) => !open.has(d)); }
  private privacyState(): PrivacyState { return { locked: [...this.locked], grants: this.activeGrants(), requests: this.f.requests, activity: [...this.activity].reverse(), problems: clone(this.problems) }; }
  private view(a: ApprovalRecord): ApprovalView {
    const digest = mockDigest(a);
    return { ...a, digest, from_app: this.mine.get(a.id) === digest };
  }
  private log(event: string, detail: string): void { this.activity.push({ at: this.iso(), event, detail }); }
  private applyState(slug: string, id: string): ApplyState {
    const j = this.find(slug, id);
    // A cover letter the person turned off is only a placeholder: never shown for review (like the services).
    const files = (this.appFiles.get(`${slug}/${id}`) ?? []).filter((f) => !(f.label === "cover-letter.md" && isNotRequested(this.f.texts[f.rel] ?? "")));
    // Like the services: the latest hand-off, or the latest email send proposed as an application (with its preview).
    const found = [...this.f.approvals, ...this.mailMock.approvals].reverse()
      .find((a) => a.payload.company_slug === slug && a.payload.id === id && (a.action === "apply_handoff" || (a.action === "email_send" && a.payload.purpose === "apply")));
    const approval = found ? this.mailMock.withEmail(this.view(found)) : null;
    const claimsText = this.f.texts[`companies/${slug}/jobs/${id}/application/claims.json`];
    const url = [j.job.apply_via, j.job.url].find((u) => u.startsWith("https://")) ?? "";
    return {
      company_slug: slug, id, title: j.job.title, company_name: j.company.name, url, step: applyStep(j.job.status, files, approval),
      files, claims: claimsText ? JSON.parse(claimsText) : null, approval, prompt: buildApplyPrompt(j.job.title, j.company.name, slug, id),
      apply_email: this.mailMock.applyEmail(slug, id),
    };
  }
  /** Which files exist: files Claude "wrote" in tests, application files, then the fixture's texts (no time). */
  private probe: Probe = (rel) => {
    const at = this.actionOutputs.get(rel) ?? [...this.appFiles.values()].flat().find((f) => f.rel === rel)?.at;
    if (at !== undefined) return { exists: true, at };
    return { exists: Object.hasOwn(this.f.texts, rel), at: "" };
  };
  /** A folder "exists" when any known file sits inside it. */
  private folders: FolderProbe = (rel) => {
    const inside = (p: string) => p.startsWith(`${rel}/`);
    return [...this.actionOutputs.keys()].some(inside) || Object.keys(this.f.texts).some(inside);
  };
  private actionInfo(t: ActionTarget): PromptInfo {
    const job = deriveTarget(t, "job");
    if (job?.kind === "job") {
      const j = this.find(job.company_slug, job.id);
      return { title: j.job.title, company: j.company.name, work_rights: this.status(), languages: spokenLanguages(getPath(this.f.profile, "languages")) };
    }
    const company = deriveTarget(t, "company");
    if (company?.kind === "company") {
      const c = this.f.companies.find((x) => x.slug === company.company_slug);
      if (!c) throw new Error(`no company ${company.company_slug}`);
      return { company: c.name, work_rights: this.status() };
    }
    return { work_rights: this.status() };
  }
  private actionView(id: ActionId, target: ActionTarget): ActionStatusView {
    const t = ownTarget(id, target);
    const req = this.actionRequests.get(actionKey(id, t));
    return actionStatusView({
      id, target: t, info: this.actionInfo(t), requested_at: req?.at ?? "", requested_folder: req?.folder, now: this.now,
      probe: this.probe, folders: this.folders,
    });
  }
  private addAppFile(slug: string, id: string, name: string, text: string): void {
    const key = `${slug}/${id}`;
    const rel = `companies/${slug}/jobs/${id}/application/${name}`;
    this.f.texts[rel] = text;
    const list = (this.appFiles.get(key) ?? []).filter((x) => x.path !== `application/${name}`);
    list.push({ path: `application/${name}`, rel, label: name, at: this.iso(), exists: true, size: text.length, kind: fileKind(name) });
    this.appFiles.set(key, list);
  }

  private docsState(slug: string, id: string): ExportState {
    this.find(slug, id);
    return {
      sources: EXPORT_SOURCES.map((source) => {
        const p = exportSourceRel(slug, id, source);
        return { source, path: p, exists: Object.hasOwn(this.f.texts, p) && !isNotRequested(this.f.texts[p] ?? "") };
      }),
      files: EXPORT_SOURCES.flatMap((source) => EXPORT_FORMATS.map((format) => {
        const p = exportRel(slug, id, source, format);
        const made = this.exportsMade.get(p);
        return { source, format, name: `${source}.${format}`, path: p, exists: !!made, size: made?.size ?? null, at: made?.at ?? "", problem: null };
      })),
    };
  }

  private resumeKey(ref: ResumeRef, file: string) { return ref.kind === "job" ? `${ref.company_slug}/${ref.id}/${file}` : `variant:${ref.variant}/${file}`; }
  private resumeRel(ref: ResumeRef, file: string) { return ref.kind === "job" ? `companies/${ref.company_slug}/jobs/${ref.id}/application/${file}` : `${VARIANTS_DIR}/${ref.variant}/${file}`; }
  private resumeOf(ref: ResumeRef, file: string): MockResume {
    if (ref.kind === "job") this.find(ref.company_slug, ref.id);
    else if (!this.variantMeta.has(ref.variant)) throw new Error("This resume version's folder isn't there any more, or isn't a plain folder in the workspace.");
    const r = this.resumeDocs.get(this.resumeKey(ref, file));
    if (!r) {
      const rel = this.resumeRel(ref, file);
      const text = this.f.texts[rel];
      if (text === undefined) throw new Error(ref.kind === "job" ? "This job has no tailored resume yet. Prepare the application first." : "Claude hasn't written this version yet. Write it from the Resumes screen first.");
      const made: MockResume = { rel, md: text, style: { ...DEFAULT_RESUME_STYLE }, savedAt: this.actionOutputs.get(rel) ?? this.iso(), versions: [] };
      this.resumeDocs.set(this.resumeKey(ref, file), made);
      return made;
    }
    return r;
  }
  private resumeState(ref: ResumeRef, file: string): ResumeState {
    const r = this.resumeOf(ref, file);
    const job = ref.kind === "job" ? this.find(ref.company_slug, ref.id) : null;
    const sp = job && file === SUGGESTED_FOR ? this.suggestedRel(job.job.company_slug, job.job.id) : "";
    const sug = sp ? this.f.texts[sp] : undefined;
    const sugAt = sp ? this.actionOutputs.get(sp) ?? r.savedAt : "";
    return {
      ref, file, title: job ? job.job.title : this.variantMeta.get((ref as { variant: string }).variant)!.name, company_name: job ? job.company.name : "",
      markdown: r.md, digest: mockHash(r.md), style: clone(r.style), saved_at: r.savedAt,
      versions: [...r.versions].reverse().map((v) => ({ id: v.id, kind: v.kind, at: v.at, size: v.text.length })),
      suggestion: sug === undefined ? null : { markdown: sug, at: sugAt, older: Date.parse(r.savedAt) > Date.parse(sugAt) },
      suggestion_problem: null,
    };
  }
  /** Test and preview hook: a general version, optionally already written. */
  /** Preview-only: tailored resumes for the first n jobs, versions with long names, and a second own resume. */
  seedResumeDemo(n: number): void {
    for (const j of this.f.jobs.slice(0, n)) this.seedResume(j.job.company_slug, j.job.id, ALEX_RESUME);
    this.seedVariant("backend-heavy", "Backend-heavy", ALEX_RESUME);
    this.seedVariant("consulting", "For consulting firms and IT services companies in Sampletown and nearby", ALEX_RESUME);
    this.seedVariant("not-yet", "Platform and infrastructure");
    this.filed.push({ at: "2026-01-12T09:00:00.000Z", name: "Alex Example - Senior Applied AI Engineer resume - final version 3.docx", to: "me/resumes/Alex Example - Senior Applied AI Engineer resume - final version 3.docx", note: "Sample resume" });
    this.f.texts["me/resumes/alex-example.md"] = ALEX_RESUME;
    this.filed.push({ at: "2026-01-13T09:00:00.000Z", name: "alex-example.md", to: "me/resumes/alex-example.md", note: "Sample resume" });
  }

  seedVariant(variant: string, name: string, md: string | null = null): void {
    this.variantMeta.set(variant, { name, created_at: this.iso() });
    if (md !== null) { this.f.texts[`${VARIANTS_DIR}/${variant}/resume.md`] = md; this.actionOutputs.set(`${VARIANTS_DIR}/${variant}/resume.md`, this.iso()); }
  }
  private addVersion(r: MockResume, text: string, kind: VersionKind): void {
    const last = r.versions.at(-1);
    const t = Math.max(this.now.getTime(), last ? Date.parse(last.at) + 1 : 0);
    const at = new Date(t).toISOString();
    r.versions.push({ id: `${at.replace(/[-:.]/g, "").toLowerCase()}-${kind}`, kind, at, text });
  }
  private writeResume(r: MockResume, next: string, kind: VersionKind | "autosave"): void {
    const had = r.versions.length;
    if (!had) this.addVersion(r, r.md, "original");
    r.md = next;
    r.savedAt = this.iso();
    if (kind !== "autosave") this.addVersion(r, next, kind);
    else if (had && this.now.getTime() - Date.parse(r.versions.at(-1)!.at) >= VERSION_EVERY_MS) this.addVersion(r, next, "manual");
    this.f.texts[r.rel] = next;
  }
  private checkDigest(r: MockResume, digest: string): void {
    if (mockHash(r.md) !== digest) throw new Error("The resume changed outside the studio (Claude may have written it). Reload to see the latest before saving.");
  }

  // ---- test hooks ----------------------------------------------------------
  private suggestedRel(slug: string, id: string) { return `companies/${slug}/jobs/${id}/application/${STUDIO_DIR}/${SUGGESTED_NAME}`; }
  /** Puts a tailored resume (and optionally Claude's suggested rewrite) into a job's application folder. */
  seedResume(slug: string, id: string, md: string, suggested: string | null = null, file = "resume.md"): void {
    this.addAppFile(slug, id, file, md);
    const f = this.appFiles.get(`${slug}/${id}`)?.find((x) => x.path === `application/${file}`);
    if (f && file === "resume.md") f.label = "Tailored resume";
    this.resumeDocs.delete(this.resumeKey({ kind: "job", company_slug: slug, id }, file));
    this.resumeOf({ kind: "job", company_slug: slug, id }, file);
    if (suggested !== null) this.writeSuggested(slug, id, suggested);
  }
  private writeSuggested(slug: string, id: string, text: string): void {
    const p = this.suggestedRel(slug, id);
    this.f.texts[p] = text;
    this.actionOutputs.set(p, this.iso());
  }
  /** Pretend a rewrite_resume run wrote application/.studio/resume.suggested.md. */
  simulateSuggestion(slug: string, id: string, text: string): void {
    this.writeSuggested(slug, id, text);
    this.emit("jobs");
  }
  /** Main's mapping of Resume Studio's positions to rewrite_resume's ids, against the saved resume. */
  private mapRequest(id: ActionId, t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
    if (id === "draft_email") return this.mapEmailRequest(t, req);
    if (RECRUITER_EMAIL_IDS.includes(id)) return this.mapRecruiterEmail(id, t, req);
    if (id !== "rewrite_resume" || t.kind !== "job" || !Object.keys(req.options ?? {}).length) return req;
    let o;
    try { o = rewriteOptions(req.options, "options"); } catch { throw new Error("Choose what to rewrite in Resume Studio."); }
    return { ...req, options: studioRewriteOptions(parseResume(this.resumeOf({ kind: "job", company_slug: t.company_slug, id: t.id }, SUGGESTED_FOR).md), o) };
  }
  /** Main's recruiter email check (services recruiterEmailRequest): the agency is saved (and lists the job); a general enquiry gets its company folder. */
  private mapRecruiterEmail(id: ActionId, t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
    const agency = (slug: unknown) => (this.f.agencies ?? []).find((x) => x.slug === slug);
    if (id === "recruiter_email") {
      if (t.kind !== "company") throw new Error("Pick the recruiter to write to.");
      this.recruiters.mailbox(t.company_slug);
      return req;
    }
    if (t.kind !== "job") throw new Error("Pick the job to write about.");
    const a = agency(req.options?.agency);
    if (!a) throw new Error("Pick the recruiter to write to.");
    if (![...a.job_refs, ...a.people.flatMap((p) => p.job_refs)].includes(`${t.company_slug}/${t.id}`)) throw new Error("That recruiter didn't advertise this job.");
    return req;
  }
  /** Pretend a recruiter email run wrote its suggestion (fictional text, with the run's note and options). */
  private writeRecruiterSuggestion(id: ActionId, t: ActionTarget, path: string): void {
    const last = [...this.claudeSim.requests].reverse().find((r) => r.action === id && actionKey(r.action, r.target) === actionKey(id, t));
    const o = last?.request.options ?? {};
    const note = last?.request.note ?? "";
    const job = t.kind === "job" ? this.find(t.company_slug, t.id).job : null;
    const agency = (this.f.agencies ?? []).find((a) => a.slug === (t.kind === "company" ? t.company_slug : o.agency));
    const lines = ["Hi,", "", job ? `I'd like to apply for the ${job.title} role you advertised.` : `I'm looking for data and AI roles, and ${agency?.name ?? "your agency"} recruits for the kind of work I do.`];
    if (note) lines.push("", `(Your note: ${note})`);
    if (o.sponsorship === true) lines.push("", "I would need visa sponsorship. Do your clients sponsor for these roles?");
    lines.push("", o.attached === true ? "My resume is attached." : "I'm happy to send my resume.", "", "Regards,", "Alex");
    this.f.texts[path] = JSON.stringify({ subject: job ? `${job.title}: Alex Example (written by Claude)` : "Data and AI roles: Alex Example (written by Claude)", body: lines.join("\n") });
  }
  /** Main's draft_email mapping (services mail-ai emailRequest): check the saved draft, and set `thread` itself. */
  private mapEmailRequest(t: ActionTarget, req: ClaudeRunRequest): ClaudeRunRequest {
    if (t.kind !== "job") return req;
    const { thread: _ignored, ...options } = req.options ?? {};
    const rework = ["shorter", "warmer", "formal", "grammar"].includes(String(options.mode));
    const draftId = typeof options.draft_id === "string" ? options.draft_id : "";
    let thread = false;
    if (draftId) {
      const d = this.mailMock.draftFor(t.company_slug, t.id, draftId);
      if (!d) throw new Error("Save the draft first, then ask Claude again.");
      if (d.sent) throw new Error("This email was already sent. Start a new draft.");
      if (rework && !d.input.body.trim()) throw new Error("Write something first, then Claude can rework it.");
      thread = !!d.input.in_reply_to && this.mailMock.hasMessage(t.company_slug, t.id, d.input.in_reply_to);
    } else if (rework) throw new Error("Write something first, then Claude can rework it.");
    return { ...req, options: { ...options, ...(thread ? { thread: true } : {}) } };
  }
  /** Pretend a draft_email run wrote its suggestion (fictional text for the run's purpose and change). */
  private writeEmailSuggestion(t: ActionTarget, path: string): void {
    if (t.kind !== "job") return;
    const key = actionKey("draft_email", t);
    const last = [...this.claudeSim.requests].reverse().find((r) => r.action === "draft_email" && actionKey(r.action, r.target) === key);
    const o = last?.request.options ?? {};
    const draftId = typeof o.draft_id === "string" ? o.draft_id : "";
    const j = this.mailHooks.jobName(t.company_slug, t.id);
    const current = draftId ? this.mailMock.draftFor(t.company_slug, t.id, draftId)?.input ?? null : null;
    this.f.texts[path] = JSON.stringify(mockEmailDraft({ purpose: String(o.purpose ?? "application"), mode: String(o.mode ?? "new"), title: j.title, company: j.company, current }));
  }
  simulateExternalEdit(slug: string, id: string, md: string, file = "resume.md"): void {
    const r = this.resumeOf({ kind: "job", company_slug: slug, id }, file);
    r.md = md;
    this.f.texts[r.rel] = md;
    this.emit("jobs");
  }
  /** Test hook: moves the mock clock. */
  setNow(d: Date): void { this.now = d; }

  /**
   * Pretend Claude wrote the application files into the job folder. `claims` accepts the
   * usual boolean (write the default claims.json, or none at all) or an explicit list, so
   * tests can cover an empty list or claims with a missing/invalid source.
   */
  simulateClaudeOutput(slug: string, id: string, claims: boolean | ClaimLink[] = true, coverLetter = "Dear hiring team,\n\nI would like to apply for this role (fictional).\n"): void {
    this.addAppFile(slug, id, "resume.md", "# Alex Example\n\nAI Engineer. Built retrieval pipelines (fictional).\n");
    this.addAppFile(slug, id, "cover-letter.md", coverLetter);
    const list = Array.isArray(claims) ? claims : claims ? [{ claim: "Built retrieval pipelines", source: "me/history/roles.md" }] : null;
    if (list) this.addAppFile(slug, id, "claims.json", JSON.stringify(list));
    this.emit("jobs");
  }
  /** Pretend Claude wrote every output file of an action (a score, a report, a rendered video). */
  simulateActionOutput(id: ActionId, target: ActionTarget): void {
    if (id === "suggest_targets") {
      this.suggested = {
        roles: ["AI Engineer", "Machine Learning Engineer", "Data Scientist"], keywords: ["Python", "LLMs", "RAG", "SQL", "AWS"], seniority: "Senior", at: this.iso(),
        related_titles: ["Applied AI Engineer", "LLM Engineer", "Generative AI Engineer", "AI Developer", "Machine Learning Engineer", "AI Solutions Engineer"],
      };
      this.f.texts[SUGGESTIONS_REL] = JSON.stringify(this.suggested);
    }
    for (const o of this.actionView(id, target).outputs) {
      this.actionOutputs.set(o.path, this.iso());
      if (id === "draft_email") { this.writeEmailSuggestion(target, o.path); continue; }
      if (RECRUITER_EMAIL_IDS.includes(id)) { this.writeRecruiterSuggestion(id, target, o.path); continue; }
      // rewrite_resume: the whole resume with a fictional rewrite in place, like the real action.
      if (o.path.endsWith(`/${STUDIO_DIR}/${SUGGESTED_NAME}`) && target.kind === "job") {
        const md = this.f.texts[`companies/${target.company_slug}/jobs/${target.id}/application/${SUGGESTED_FOR}`];
        if (md !== undefined) { this.f.texts[o.path] = mockRewrite(md); continue; }
      }
      // A tailored resume or a general version: a whole fictional resume, so the studio has something to open.
      if (/(^|\/)resume\.md$/.test(o.path) && !Object.hasOwn(this.f.texts, o.path)) { this.f.texts[o.path] = ALEX_RESUME; continue; }
      // A study guide needs text for the reader.
      if (/^learning\/[^/]+\/guide\.md$/.test(o.path) && !Object.hasOwn(this.f.texts, o.path)) this.f.texts[o.path] = "# Study guide\n\nA fictional guide Claude wrote.\n";
      // A score run ends with score_record: the structured score beside the write-up, and the record's scores.
      if (id === "score_job" && target.kind === "job" && /(^|\/)score\.md$/.test(o.path)) {
        const at = this.iso();
        this.f.texts[o.path] = DEMO_SCORE_MD;
        this.f.texts[o.path.replace(/score\.md$/, "score.json")] = JSON.stringify({ ...DEMO_SCORE, scored_at: at });
        const j = this.find(target.company_slug, target.id).job;
        j.scores.fit = { value: DEMO_SCORE.fit, must_haves: DEMO_SCORE.must_haves.map((m) => ({ ...m, met: m.status === "met" })), nice_to_haves: [...DEMO_SCORE.nice_to_haves] };
        j.scores.career = { match: DEMO_SCORE.fit, odds: DEMO_SCORE.interview_odds, tier: DEMO_SCORE.tier, scored_at: at };
        this.event(this.find(target.company_slug, target.id), "Scored", `Fit ${DEMO_SCORE.fit}/100 · ${DEMO_SCORE.tier}`);
        continue;
      }
      // Text outputs get placeholder text too, so screens that read them (the job's score) agree with "ready".
      if (/\.(md|txt)$/.test(o.path) && !Object.hasOwn(this.f.texts, o.path)) {
        this.f.texts[o.path] = /(^|\/)score\.md$/.test(o.path)
          ? "# Job score: 78/100\n\nStrong match on retrieval and LLM work. Visa sponsorship isn't mentioned (fictional preview).\n"
          : "# Written by Claude\n\nPreview text (fictional).\n";
      }
    }
    this.emit("jobs", "learn", "searches");
  }
  emitExternalChange(...areas: ChangeArea[]): void { this.emit(...areas); }
  /** A locked folder found moved or replaced, as the services' folder check would report it. */
  simulateLockProblem(p: LockProblemView): void { this.problems.push(clone(p)); this.emit("privacy", "home"); }
  /** Changes an approval record "on disk" without telling the screens, like Claude editing it after the card was drawn. */
  simulateApprovalEdit(id: string, patch: Partial<ApprovalRecord>): void {
    const a = this.f.approvals.find((x) => x.id === id);
    if (!a) throw new Error(`no approval ${id}`);
    Object.assign(a, clone(patch));
  }
  /**
   * Fast-forwards a pending apply_handoff approval straight to "approved" (not yet "done",
   * to show the in-between "finishing" state) or "failed" (e.g. the user cancelled the OS
   * "open link" dialog), bypassing the normal approve() flow, which always finishes
   * synchronously in this mock and so can never be observed mid-flight.
   */
  simulateHandoffStatus(slug: string, id: string, status: "approved" | "failed", note = ""): void {
    const a = [...this.f.approvals].reverse().find((x) => x.action === "apply_handoff" && x.payload.company_slug === slug && x.payload.id === id && x.status === "pending");
    if (!a) throw new Error(`no pending apply_handoff for ${slug}/${id}`);
    a.status = status;
    if (note) a.result_note = note;
    this.emit("approvals", "jobs", "home");
  }

  // ---- bridge --------------------------------------------------------------
  /** In-app updates: "Check for updates" finds nothing; tests (and the dev harness) move it with `setUpdateStatus`. */
  updateStatus: UpdateStatus = { kind: "idle" };
  updatesAuto = true;
  updatesSupported = true;
  setUpdateStatus(s: UpdateStatus): void { this.updateStatus = s; this.emit("updates"); }
  private updateView(): UpdateView { return { current: "0.1.0", supported: this.updatesSupported, auto: this.updatesAuto, status: this.updateStatus }; }

  app = {
    info: () => this.rec("app.info", [], (): AppInfo => ({ version: "0.1.0", shell: "mock", platform: "mock" })),
    updates: {
      state: () => this.rec("app.updates.state", [], () => this.updateView()),
      check: () => this.rec("app.updates.check", [], () => {
        if (!this.updatesSupported) throw new Error("Updates work in the installed app. Download the newest version from GitHub instead.");
        if (this.updateStatus.kind !== "ready" && this.updateStatus.kind !== "downloading") this.setUpdateStatus({ kind: "none", checked_at: this.iso() });
        return this.updateView();
      }),
      install: () => this.rec("app.updates.install", [], () => {
        if (this.updateStatus.kind !== "ready") throw new Error("There's no downloaded update to install yet.");
      }),
      setAuto: (on: boolean) => this.rec("app.updates.setAuto", [on], () => { this.updatesAuto = on; this.emit("updates"); return this.updateView(); }),
    },
  };

  workspace = {
    current: () => this.rec("workspace.current", [], () => (this.isOpen ? this.summary() : null)),
    pickFolder: (purpose: "create" | "open" | "legacy") => this.rec("workspace.pickFolder", [purpose], (): string | null =>
      purpose === "legacy" ? "/fictional/alex-example/OldCareerFolder" : "/fictional/alex-example/CareerOS"),
    suggest: () => this.rec("workspace.suggest", [], () => this.suggestion),
    // Main picks the folder: the same one suggest() shows. A new folder starts with no name (the setup page asks).
    start: () => this.rec("workspace.start", [], () => {
      this.isOpen = true; this.sample = false; this.f.workspace.root = this.suggestion.dir;
      if (!this.suggestion.existing) { setPath(this.f.profile, "contact.name", ""); this.welcome(); }
      this.track(); this.emit("workspace"); return this.summary();
    }),
    create: (dir: string, name: string) => this.rec("workspace.create", [dir, name], () => {
      this.isOpen = true; this.sample = false; this.f.workspace.root = dir; setPath(this.f.profile, "contact.name", name); this.welcome(); this.track(); this.emit("workspace"); return this.summary();
    }),
    // A fresh copy of the fictional example every time, so it always starts pristine.
    openSample: () => this.rec("workspace.openSample", [], () => {
      this.leave();
      this.f = clone(this.pristine); this.f.workspace.root = `${MOCK_HOME}/${PRODUCT_NAME} Example`;
      this.isOpen = true; this.sample = true; this.track(); this.spaces[0]!.isSample = true; this.emit(...CHANGE_AREAS); return this.summary();
    }),
    open: (dir: string) => this.rec("workspace.open", [dir], () => { this.isOpen = true; this.sample = false; this.f.workspace.root = dir; this.track(); this.emit("workspace"); return this.summary(); }),
    previewLegacy: (src: string, dest: string) => this.rec("workspace.previewLegacy", [src, dest], (): LegacyPreview => ({
      actions: [
        { kind: "job", from: "Company/Acme Corp", to: "companies/acme-corp/jobs/2026-01-12-ai-engineer" },
        { kind: "copy", from: "Resume/alex-example-resume.pdf", to: "me/resumes/alex-example-resume.pdf" },
      ],
      unmapped: ["Notes"], skipped: [".DS_Store"], issues: [],
    })),
    importLegacy: (src: string, dest: string) => this.rec("workspace.importLegacy", [src, dest], (): LegacyPreview => {
      this.isOpen = true; this.sample = false; this.f.workspace.root = dest; this.track(); this.emit("workspace");
      return { actions: [{ kind: "job", from: "Company/Acme Corp", to: "companies/acme-corp/jobs/2026-01-12-ai-engineer" }], unmapped: ["Notes"], skipped: [], issues: [] };
    }),
    close: () => this.rec("workspace.close", [], () => { this.isOpen = false; this.sample = false; this.emit("workspace"); }),
    recent: () => this.rec("workspace.recent", [], () => this.recentList()),
    switchTo: (key: string) => this.rec("workspace.switchTo", [key], () => {
      const s = this.spaces.find((x) => x.key === key);
      if (!s) throw new Error("That workspace isn't in the list any more. Use Open another workspace to find it.");
      if (!s.available) throw new Error("That workspace's folder can't be found. It may have been moved or deleted. Remove it from the list, or use Open another workspace to find it.");
      if (!(this.isOpen && key === this.currentKey)) {
        this.leave();
        this.f = this.stash.get(key) ?? this.emptyWorkspace(s.root, s.name);
        this.sample = s.isSample; this.isOpen = true; this.track(); this.emit(...CHANGE_AREAS);
      }
      return this.summary();
    }),
    forget: (key: string) => this.rec("workspace.forget", [key], () => {
      if (!this.spaces.some((x) => x.key === key)) throw new Error("That workspace isn't in the list any more. Use Open another workspace to find it.");
      if (this.isOpen && key === this.currentKey) throw new Error("This workspace is open. Switch to another workspace first, then remove it from the list.");
      this.spaces = this.spaces.filter((x) => x.key !== key); this.stash.delete(key);
      return this.recentList();
    }),
    trash: (key: string) => this.rec("workspace.trash", [key], () => {
      const r = this.recentList().find((x) => x.key === key);
      if (!r) throw new Error("That workspace isn't in the list any more. Use Open another workspace to find it.");
      if (r.current) throw new Error("This workspace is open. Nothing was moved.");
      if (!r.empty) throw new Error("This workspace has your files in it, so it can only be removed from the list. Nothing was moved.");
      this.trashed.push(r.folder);
      this.spaces = this.spaces.filter((x) => x.key !== key); this.stash.delete(key);
      this.emit("workspace");
      return this.recentList();
    }),
    locate: (key: string, dir: string) => this.rec("workspace.locate", [key, dir], () => {
      const s = this.spaces.find((x) => x.key === key);
      if (!s) throw new Error("That workspace isn't in the list any more. Use Open another workspace to find it.");
      if (s.available) throw new Error("That folder is there now. Choose it from the list.");
      // The mock's "same workspace" rule: the picked folder has the same name.
      const relinked = dir.split("/").pop() === s.folder;
      if (relinked) { s.root = dir; s.available = true; this.emit("workspace"); }
      return { relinked, list: this.recentList() };
    }),
    addRecent: (dir: string) => this.rec("workspace.addRecent", [dir], () => {
      if (!this.spaces.some((x) => x.root === dir)) {
        const at = this.isOpen ? 1 : 0;
        this.spaces.splice(at, 0, { key: this.nextKey(), root: dir, folder: dir.split("/").pop() ?? dir, name: "", available: true, isSample: false, companies: 3 });
        this.emit("workspace");
      }
      return this.recentList();
    }),
    startNew: (name: string) => this.rec("workspace.startNew", [name], () => {
      const base = `${MOCK_HOME}/${PRODUCT_NAME}${name.trim() ? ` ${name.trim()}` : ""}`;
      let root = base;
      for (let i = 2; this.spaces.some((x) => x.root === root) || root === this.f.workspace.root; i++) root = `${base} ${i}`;
      this.leave();
      this.f = this.emptyWorkspace(root, name.trim());
      this.welcome();
      this.sample = false; this.isOpen = true; this.track(); this.emit(...CHANGE_AREAS);
      return this.summary();
    }),
  };

  home = {
    summary: () => this.rec("home.summary", [], () => homeSummary({
      name: String(getPath(this.f.profile, "contact.name") ?? ""), rows: this.rows(),
      events: this.f.jobs.flatMap((j) => j.job.timeline.map((e) => ({ company_slug: j.job.company_slug, job_id: j.job.id, at: e.at, event: e.event }))),
      visaExpiry: String(getPath(this.f.profile, "work_rights.visa_expiry") ?? ""),
      status: this.status(),
      approvals: this.allApprovals().map((a) => this.view(a)), requests: this.f.requests, inbox: this.inboxItems(), now: this.now,
      mail: this.mailMock.nextUp(),
      searches: this.f.searches,
      goals: { search_deadline: String(getPath(this.f.search, "search_deadline") ?? ""), weekly_goal: (getPath(this.f.search, "weekly_goal") as number | null | undefined) ?? null },
    })),
  };

  jobs = {
    list: (q: JobQuery) => this.rec("jobs.list", [q], () => applyJobQuery(withGhostFlags(this.rows(), new Map(), this.now), q, prioritiseSponsorship(this.status()), this.now)),
    get: (slug: string, id: string) => this.rec("jobs.get", [slug, id], () => this.detail(this.find(slug, id))),
    setStatus: (slug: string, id: string, status: JobStatus, note: string) => this.rec("jobs.setStatus", [slug, id, status, note], () => {
      const j = this.find(slug, id); this.setJobStatus(j, status, note); this.emit("jobs", "home"); return this.detail(j);
    }),
    addNote: (slug: string, id: string, note: string) => this.rec("jobs.addNote", [slug, id, note], () => {
      const j = this.find(slug, id); this.event(j, "Note", note); this.emit("jobs"); return this.detail(j);
    }),
    attach: (slug: string, id: string, src: string, label: string, subdir: JobSubdir) => this.rec("jobs.attach", [slug, id, src, label, subdir], () => {
      const j = this.find(slug, id);
      j.job.files.push({ path: `${subdir ? `${subdir}/` : ""}${basename(src)}`, label, at: this.iso() });
      this.emit("jobs"); return this.detail(j);
    }),
    views: () => this.rec("jobs.views", [], () => this.views),
    saveView: (name: string, query: JobQuery) => this.rec("jobs.saveView", [name, query], () => {
      this.views = [...this.views.filter((v) => v.name !== name), { name, query }]; return this.views;
    }),
    deleteView: (name: string) => this.rec("jobs.deleteView", [name], () => { this.views = this.views.filter((v) => v.name !== name); return this.views; }),
    preview: (input: { url?: string; text?: string }) => this.recAsync("jobs.preview", [input], () => this.previewJob(input)),
    previewFile: (path: string) => this.rec("jobs.previewFile", [path], (): JobPreviewResult => {
      const text = this.inboxTexts.get(basename(path)) ?? MOCK_AD_TEXT;
      return this.finishPreview({ ...guessFromAd(text), url: "", apply_via: "", source_site: "", jd_text: text }, "file");
    }),
    add: (draft: JobDraft, status: JobAddStatus) => this.rec("jobs.add", [draft, status], (): JobAdded => this.addJob(draft, status)),
    setInterview: (slug: string, id: string, at: string) => this.rec("jobs.setInterview", [slug, id, at], () => {
      const j = this.find(slug, id);
      if ((j.job.interview_at ?? "") !== at) { j.job.interview_at = at; this.event(j, at ? "Interview set" : "Interview cleared", at.replace("T", " ")); }
      this.emit("jobs", "home"); return this.detail(j);
    }),
    setOffer: (slug: string, id: string, offer: OfferDetails) => this.rec("jobs.setOffer", [slug, id, offer], () => {
      const j = this.find(slug, id);
      if (!j.job.offer) this.event(j, "Offer details added");
      j.job.offer = offerOf(offer);
      this.emit("jobs"); return this.detail(j);
    }),
    addToCalendar: (slug: string, id: string, kind: CalendarKind) => this.rec("jobs.addToCalendar", [slug, id, kind], () => {
      const j = this.find(slug, id);
      const ev = jobCalendarEvent(j.job, j.company.name, kind, this.now);
      if (!ev) throw new Error(kind === "interview" ? "Set the interview date and time first." : "A follow-up date shows once you've applied.");
      this.openedFiles.push(`companies/${slug}/jobs/${id}/calendar/${kind === "interview" ? "interview" : "follow-up"}.ics`);
    }),
  };

  /** Links the preview may "read": applicant systems give a fictional ad; boards need the mock Chrome (`?chrome`). */
  private async previewJob(input: { url?: string; text?: string }): Promise<JobPreviewResult> {
    const url = input.url?.trim() ?? "";
    if (input.text?.trim()) {
      const site = url ? routeJobLink(url)?.site ?? "" : "";
      return this.finishPreview({ ...guessFromAd(input.text, { site }), url, apply_via: "", source_site: site, jd_text: input.text.trim() }, "text");
    }
    if (!url) return { ok: false, need: "paste", text: "Paste a job link or the ad's text.", site: "" };
    const route = routeJobLink(url);
    if (!route) return { ok: false, need: "not_found", text: "That isn't a web link. Copy the link from the address bar, starting with https://.", site: "" };
    await new Promise((r) => setTimeout(r, this.claudeSim.opts.autoRun ? 600 : 0));
    if (route.kind === "paste") return { ok: false, need: "paste", text: `${route.site || "This site"} isn't read from the app. Copy the ad's text on that page and paste it here.`, site: route.site };
    if (route.kind === "chrome") {
      const chrome = (this as unknown as { chrome?: { state(r: boolean): Promise<{ connected: boolean }> } }).chrome;
      if (!chrome || !(await chrome.state(false)).connected) {
        return { ok: false, need: "connect_chrome", text: `${route.site} ads are read in your own Chrome. Connect to Chrome, or paste the ad's text.`, site: route.site };
      }
      return this.finishPreview({ ...guessFromAd(MOCK_BOARD_AD), url: adAddress(url), apply_via: "", source_site: route.site, jd_text: MOCK_BOARD_AD }, "chrome");
    }
    const org = (() => { try { return new URL(url).pathname.split("/").filter(Boolean)[0] ?? "example-labs"; } catch { return "example-labs"; } })();
    const company = org.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return this.finishPreview({
      url, title: "Applied AI Engineer", company, location: "Sampletown NSW", work_mode: "Hybrid", job_type: "Full time", salary: "$150k–$170k per year",
      posted: "2026-01-14", apply_via: url, source_site: route.site, jd_text: MOCK_AD_TEXT,
    }, "ats");
  }

  private finishPreview(d: Omit<JobDraft, "rights" | "rights_quotes">, via: JobPreview["via"]): JobPreviewResult {
    const rights = scanWorkRights(d.jd_text);
    const draft: JobDraft = { ...d, rights: rights.label, rights_quotes: rights.quotes };
    return { ok: true, preview: { draft, via, duplicate: this.duplicateOf(draft), warnings: [] } };
  }

  private duplicateOf(d: Pick<JobDraft, "url" | "company" | "title">): JobDuplicate | null {
    const key = d.url ? jobAdKey(d.url) : "";
    const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const byLink = key ? this.f.jobs.find((j) => j.job.url && jobAdKey(j.job.url) === key) : undefined;
    const byTitle = this.f.jobs.find((j) => j.job.company_slug === slugOf(d.company) && slugOf(j.job.title) === slugOf(d.title));
    const hit = byLink ?? byTitle;
    return hit ? { company_slug: hit.job.company_slug, id: hit.job.id, title: hit.job.title, company_name: hit.company.name, by: byLink ? "link" : "title" } : null;
  }

  private addJob(draft: JobDraft, status: JobAddStatus): JobAdded {
    const dup = this.duplicateOf({ ...draft, url: draft.url ? adAddress(draft.url) : "" });
    if (dup) return { company_slug: dup.company_slug, id: dup.id, created: false, title: dup.title, company_name: dup.company_name };
    const slug = draft.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
    const id = `${this.iso().slice(0, 10)}-${draft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "job"}`;
    const made = clone(this.f.jobs[0]!);
    const route = draft.url ? routeJobLink(draft.url) : null;
    Object.assign(made.job, {
      id, company_slug: slug, title: draft.title, status, found_at: this.iso(), url: draft.url ? adAddress(draft.url) : "",
      source: route?.kind === "ats" ? "ats" : "pasted", source_site: draft.source_site, location: draft.location, work_mode: draft.work_mode,
      job_type: draft.job_type, posted: draft.posted, apply_via: draft.apply_via, salary: { ...made.job.salary, text: draft.salary, min: null, max: null },
      work_rights: { label: draft.rights, quotes: draft.rights_quotes, decided_by: "user" },
      scores: { ...made.job.scores, fit: { ...made.job.scores.fit, value: null }, sponsor: { ...made.job.scores.sponsor, value: 20, tier: "Low", reasons: ["New employer: nothing known yet"] } },
      timeline: [{ at: this.iso(), event: "Found", note: draft.source_site || "pasted" }, ...(status === "Saved" ? [{ at: this.iso(), event: "Status: Saved", note: "Added by you" }] : [])],
      files: draft.jd_text ? [{ path: "jd.md", label: "Job description", at: this.iso() }] : [],
    });
    made.company = { ...made.company, name: draft.company, slug };
    made.description = draft.jd_text;
    this.f.jobs.push(made);
    this.emit("jobs", "home", "sponsors");
    return { company_slug: slug, id, created: true, title: draft.title, company_name: draft.company };
  }

  apply = {
    state: (slug: string, id: string) => this.rec("apply.state", [slug, id], () => this.applyState(slug, id)),
    prepare: (slug: string, id: string) => this.rec("apply.prepare", [slug, id], () => {
      const j = this.find(slug, id);
      if (!(this.appFiles.get(`${slug}/${id}`) ?? []).some((f) => f.path === "application/PREPARE.md")) {
        this.addAppFile(slug, id, "PREPARE.md", buildApplyPrompt(j.job.title, j.company.name, slug, id));
      }
      if (j.job.status === "Found" || j.job.status === "Saved") this.setJobStatus(j, "Applying", "Preparing the application");
      this.emit("jobs", "home");
      return this.applyState(slug, id);
    }),
    requestApproval: (slug: string, id: string) => this.rec("apply.requestApproval", [slug, id], () => {
      const st = this.applyState(slug, id);
      const files = st.files.filter((f) => !f.path.endsWith("PREPARE.md"));
      if (!files.length) throw new Error("Nothing to hand off yet. Prepare the application first.");
      const a: ApprovalRecord = {
        id: `20260115t090000-mock${++this.seq}`, action: "apply_handoff", title: `Hand off application to ${st.company_name}`,
        summary: `${files.length} file(s) ready for ${st.title}.`,
        steps: [...(st.url ? [`Open ${st.url} in your browser`] : []), `Show the application folder (${files.length} files)`, 'Add a timeline event "Handed off"'],
        payload: { company_slug: slug, id, url: st.url, files: files.map((f) => f.path) }, created_at: this.iso(), created_by: "app",
        status: "pending", decided_at: "", result_note: "",
      };
      this.f.approvals.push(a);
      this.mine.set(a.id, mockDigest(a));
      this.emit("approvals", "home");
      return this.applyState(slug, id);
    }),
    markApplied: (slug: string, id: string) => this.rec("apply.markApplied", [slug, id], () => {
      this.setJobStatus(this.find(slug, id), "Applied", `Marked applied in ${PRODUCT_NAME}`); this.emit("jobs", "home"); return this.applyState(slug, id);
    }),
  };

  inbox = {
    list: () => this.rec("inbox.list", [], () => this.inboxItems()),
    overview: () => this.rec("inbox.overview", [], () => this.overview()),
    add: (paths: string[]) => this.rec("inbox.add", [paths], () => {
      for (const p of paths) {
        let name = basename(p);
        for (let n = 2; this.inboxNames.includes(name); n++) name = basename(p).replace(/(\.[^.]*)?$/, `-${n}$1`);
        this.inboxNames.push(name);
        this.inboxFrom.set(name, basename(p.slice(0, Math.max(0, p.length - basename(p).length - 1))) || "its folder");
      }
      this.emit("inbox", "home"); return this.inboxItems();
    }),
    file: (name: string, target: InboxTarget, note: string) => this.rec("inbox.file", [name, target, note], () => {
      if (!this.inboxNames.includes(name)) throw new Error(`"${name}" is not in the inbox`);
      if (target.kind === "job") {
        const j = this.find(target.company_slug, target.id);
        j.job.files.push({ path: `${target.subdir ? `${target.subdir}/` : ""}${name}`, label: note || name, at: this.iso() });
      }
      this.inboxNames = this.inboxNames.filter((n) => n !== name);
      this.inboxFrom.delete(name);
      this.inboxAsks.delete(name);
      const to = target.kind === "job"
        ? `companies/${target.company_slug}/jobs/${target.id}/${target.subdir ? `${target.subdir}/` : ""}${name}`
        : `me/${target.dir}${target.sub ? `/${target.sub}` : ""}/${name}`;
      this.filed.unshift({ at: this.iso(), name, to, note });
      this.f.texts[to] = this.f.texts[to] ?? "";
      this.emit(...(target.kind === "job" ? (["inbox", "home", "jobs"] as ChangeArea[]) : (["inbox", "home"] as ChangeArea[])));
      return this.inboxItems();
    }),
    remove: (names: string[]) => this.rec("inbox.remove", [names], () => {
      const missing = names.find((n) => !this.inboxNames.includes(n));
      if (missing) throw new Error(`"${missing}" is not in the drop box`);
      this.inboxNames = this.inboxNames.filter((n) => !names.includes(n));
      for (const n of names) this.inboxFrom.delete(n);
      this.emit("inbox", "home"); return this.inboxItems();
    }),
    putBack: (name: string) => this.rec("inbox.putBack", [name], () => {
      const from = this.inboxFrom.get(name);
      if (!this.inboxNames.includes(name) || !from) throw new Error(`The drop box doesn't know where ${name} came from. Use Remove instead.`);
      this.inboxNames = this.inboxNames.filter((n) => n !== name);
      this.inboxFrom.delete(name);
      this.emit("inbox", "home");
      return { items: this.inboxItems(), text: `Moved ${name} back to ${from}.` };
    }),
    ask: (name: string) => this.rec("inbox.ask", [name], () => {
      const it = this.inboxItems().find((i) => i.name === name);
      if (!it) throw new Error(`"${name}" is not in the drop box`);
      if (!it.askable) throw new Error("This file looks like it belongs in a locked folder, so it stays on this computer and isn't sent to Claude.");
      this.inboxAsks.set(name, { state: "running" });
      if (this.inboxClaudeMode === "auto") {
        setTimeout(() => this.finishInboxAsk(name, { target: { kind: "me", dir: "projects" }, reason: "It reads like a write-up of a personal project.", confidence: "medium" }), 2500);
      }
      this.emit("inbox", "claude");
      return this.inboxItems();
    }),
    addAsJob: (name: string, job: { company: string; title: string }) => this.rec("inbox.addAsJob", [name, job], () => {
      if (!this.inboxNames.includes(name)) throw new Error(`"${name}" is not in the drop box`);
      const base = this.f.jobs[0]!;
      const slug = job.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
      const id = `${this.iso().slice(0, 10)}-${job.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "job"}`;
      const made = clone(base);
      Object.assign(made.job, { id, company_slug: slug, title: job.title, status: "Found", found_at: this.iso(), timeline: [{ at: this.iso(), event: "Found", note: "pasted" }], files: [{ path: name, label: "Job ad", at: this.iso() }] });
      made.company = { ...made.company, name: job.company, slug };
      made.description = this.inboxTexts.get(name) ?? `# ${job.title}\n`;
      this.f.jobs.push(made);
      this.inboxNames = this.inboxNames.filter((n) => n !== name);
      this.inboxFrom.delete(name);
      this.inboxAsks.delete(name);
      this.filed.unshift({ at: this.iso(), name, to: `companies/${slug}/jobs/${id}/${name}`, note: "Job ad" });
      this.emit("inbox", "home", "jobs");
      return { items: this.inboxItems(), job: { company_slug: slug, id } };
    }),
    readResume: (name: string) => this.rec("inbox.readResume", [name], (): ResumeRead => {
      this.waitingResume(name);
      return this.readMockResume(name);
    }),
    fillProfile: (name: string, values: ResumeValues, overwrite: ResumeFieldKey[]) => this.rec("inbox.fillProfile", [name, values, overwrite], (): ResumeFillState => {
      this.waitingResume(name);
      const state = this.fillMockProfile(name, values, overwrite);
      // Like main: the copy now lives in Resumes, so the drop box file goes to the Trash.
      this.inboxNames = this.inboxNames.filter((n) => n !== name);
      this.inboxFrom.delete(name);
      this.inboxAsks.delete(name);
      this.emit("settings", "jobs", "home", "inbox");
      return state;
    }),
  };

  /** Like main: only a waiting file, and never one that belongs in a locked folder. */
  private waitingResume(name: string): void {
    const it = this.inboxItems().find((i) => i.name === name);
    if (!it) throw new Error(`"${name}" is not in the drop box`);
    const t = it.suggestion.target;
    if (isLockedKind(it.kind) || (t?.kind === "me" && (LOCKABLE_DIRS as readonly string[]).includes(`me/${t.dir}`))) {
      throw new Error("This file looks like it belongs in a locked folder, so it can't be used to fill your profile.");
    }
  }

  // The mock never "reads" a locked folder either: its count is null, like the services.
  private overview(): InboxOverview {
    const locked = new Set<string>(this.locked);
    const folders = MOCK_FOLDERS.map((f): FolderSummary => {
      if (locked.has(f.rel)) return { ...f, count: null, updated: "", locked: true };
      const inside = Object.keys(this.f.texts).filter((k) => k.startsWith(`${f.rel}/`));
      return { ...f, count: inside.length, updated: inside.length ? this.iso() : "", locked: false };
    });
    return { folders, history: this.filed.slice(0, 30) };
  }

  /** Like services learnList: fixture topics, guides Claude "wrote" (study_topic), job prep and recaps. */
  private learnData(): LearnData {
    const topics = clone(this.f.learning.topics);
    for (const p of this.actionOutputs.keys()) {
      const m = /^learning\/([a-z0-9-]+)\/guide\.md$/.exec(p);
      if (m && !topics.some((t) => t.slug === m[1])) {
        const title = m[1]!.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
        topics.push({ slug: m[1]!, title, items: [{ path: p, title, kind: "guide" }] });
      }
    }
    return {
      topics: topics.sort((a, b) => a.slug.localeCompare(b.slug)),
      interviewPrep: this.f.jobs.filter((j) => j.interview.length).map((j) => ({ company_slug: j.job.company_slug, id: j.job.id, title: j.job.title, company_name: j.company.name, items: j.interview })),
      recaps: this.f.learning.recaps ?? [],
      videos: this.videoMock.items().filter((i) => i.section !== "recaps"),
      video_recaps: this.videoMock.items().filter((i) => i.section === "recaps"),
    };
  }
  private entries() {
    return learnEntries(this.learnData(), this.learnProgress, (p) => this.learnDates[p] ?? this.actionOutputs.get(p) ?? "");
  }
  /** Saved jobs with what Learn and the checklist need, eligible and newest first (like services jobFacts). */
  private jobFacts() {
    const PREP = ["Applying", "Applied", "Interview", "Offer"];
    return this.f.jobs.map((j) => {
      const base = `companies/${j.job.company_slug}/jobs/${j.job.id}`;
      const eligible = isEligible(this.status(), j.job.work_rights.label);
      return {
        company_slug: j.job.company_slug, id: j.job.id, title: j.job.title, company_name: j.company.name, gaps: gapsFrom(j.job),
        scored: !!j.job.scores.career.scored_at || this.probe(`${base}/score.md`).exists, eligible, status: j.job.status, found_at: j.job.found_at,
        preparing: PREP.includes(j.job.status) || this.probe(`${base}/application/resume.md`).exists,
        text: `${j.job.title}\n${this.f.texts[`${base}/jd.md`] ?? j.description}`,
      };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.found_at.localeCompare(a.found_at) || a.title.localeCompare(b.title));
  }
  /** The text of the person's own files in me/, never a locked folder. */
  private ownText(): string[] {
    const locked = this.lockedNow();
    const mine = Object.entries(this.f.texts).filter(([p]) => p.startsWith("me/") && !locked.some((d) => p === d || p.startsWith(`${d}/`)));
    return mine.map(([, t]) => t);
  }
  private hub(): LearnHub {
    const data = this.learnData();
    const jobs = this.jobFacts();
    const topics = new Set(data.topics.filter((t) => t.items.length).map((t) => t.slug));
    return {
      entries: this.entries(),
      // Like services: count only active jobs (eligible, not Skipped or Rejected); profile keywords are declared skills.
      suggestions: skillGaps({
        jobs: jobs.filter((j) => j.eligible && j.status !== "Skipped" && j.status !== "Rejected").map((j) => j.text), have: this.ownText(),
        declared: (getPath(this.f.profile, "targets.keywords") as string[] | undefined) ?? [], started: (s) => topics.has(s),
      }),
      ...jobsToLearn(jobs.map(({ text: _t, eligible: _e, status: _s, found_at: _f, preparing: _p, ...j }) => j)),
      jobs: jobs.length,
    };
  }
  private guideView(): GuideState {
    const jobs = this.jobFacts();
    const ref = (j: (typeof jobs)[number] | undefined): GuideJob | null => (j ? { company_slug: j.company_slug, id: j.id, title: j.title, company_name: j.company_name } : null);
    const open = jobs.filter((j) => j.eligible && ["Found", "Saved"].includes(j.status) && !j.preparing);
    const facts: GuideFacts = {
      profile: String(getPath(this.f.profile, "contact.name") ?? "").trim() !== "",
      resume: Object.keys(this.f.texts).some((p) => p.startsWith("me/resumes/")),
      prefs: prefsMissing(searchPrefsFrom(this.f.profile, this.f.search)).length === 0,
      jobs: jobs.length, scored: jobs.filter((j) => j.scored).length,
      nextToScore: ref(open.find((j) => !j.scored) ?? jobs.find((j) => !j.scored && j.eligible) ?? jobs.find((j) => !j.scored)),
      preparing: jobs.filter((j) => j.preparing).length, nextToPrepare: ref(open.find((j) => j.scored) ?? open[0]),
      learning: this.entries().length,
      email: this.mailMock.isConnected(),
    };
    return guideState(facts, this.guideDismissed, this.guideSkipped);
  }

  learn = {
    list: () => this.rec("learn.list", [], (): LearnData => this.learnData()),
    hub: () => this.rec("learn.hub", [], () => this.hub()),
    setProgress: (rel: string, progress: LearnProgress) => this.rec("learn.setProgress", [rel, progress], () => {
      if (!this.entries().some((e) => e.path === rel)) throw new Error("That item isn't in Learn any more.");
      if (progress === "not_started") delete this.learnProgress[rel];
      else this.learnProgress[rel] = { state: progress, at: this.iso() };
      this.emit("learn", "home");
      return this.hub();
    }),
  };

  guide = {
    state: () => this.rec("guide.state", [], () => this.guideView()),
    setDismissed: (dismissed: boolean) => this.rec("guide.setDismissed", [dismissed], () => {
      this.guideDismissed = dismissed;
      this.emit("home", "learn");
      return this.guideView();
    }),
    setSkipped: (id: SetupStepId, skipped: boolean) => this.rec("guide.setSkipped", [id, skipped], () => {
      if (!isSkippableSetup(id)) throw new Error("args[0] must be one of: chrome");
      this.guideSkipped = [...this.guideSkipped.filter((x) => x !== id), ...(skipped ? [id] : [])];
      this.emit("home", "learn");
      return this.guideView();
    }),
  };

  tour = {
    state: () => this.rec("tour.state", [], () => sanitizeTourState(this.tourState)),
    mark: (id: TourId, mark: TourMark) => this.rec("tour.mark", [id, mark], () => {
      this.tourState = { ...this.tourState, tours: { ...this.tourState.tours, [id]: { mark, at: this.iso() } } };
      return sanitizeTourState(this.tourState);
    }),
    replayAll: () => this.rec("tour.replayAll", [], () => { this.tourState = { off: false, replay: true, tours: {} }; return sanitizeTourState(this.tourState); }),
    setOff: (off: boolean) => this.rec("tour.setOff", [off], () => {
      this.tourState = { ...this.tourState, off, replay: off ? false : this.tourState.replay };
      return sanitizeTourState(this.tourState);
    }),
  };

  files = {
    readText: (rel: string) => this.rec("files.readText", [rel], () => {
      const lockedIn = this.lockedNow().find((d) => rel === d || rel.startsWith(`${d}/`));
      if (lockedIn) throw new Error(`${lockedIn} is locked. Allow it once in Privacy first.`);
      const t = this.f.texts[rel];
      if (t === undefined) throw new Error(`no file ${rel}`);
      return t;
    }),
    reveal: (rel: string) => this.rec("files.reveal", [rel], () => { this.revealed.push(rel); }),
    pick: (): Promise<string | null> => this.rec("files.pick", [], () => this.pickFile ?? `${DOWNLOADS}/alex-example-cover-letter.pdf`),
    preview: (rel: string) => this.rec("files.preview", [rel], () => mockPreview(rel, this.viewerTexts(rel), this.lockedNow(), this.actionOutputs.get(rel) ?? this.iso())),
    open: (rel: string) => this.rec("files.open", [rel], () => { mockOpenCheck(rel, this.lockedNow()); this.openedFiles.push(rel); }),
  };

  private sponsorRows(): SponsorRow[] {
    return buildSponsorRows(
      this.f.companies,
      this.f.employers,
      this.f.jobs.map(({ job: j }) => ({ company_slug: j.company_slug, id: j.id, title: j.title, status: j.status, sponsor: j.scores.sponsor })),
    );
  }
  sponsors = {
    list: () => this.rec("sponsors.list", [], (): SponsorRow[] => this.sponsorRows()),
  };

  private companyRows(): CompanyRow[] {
    const inputs = this.f.companies.map((c) => ({ slug: c.slug, name: c.name, website: this.f.jobs.find((j) => j.company.slug === c.slug)?.company.website ?? "" }));
    return buildCompanyRows(this.sponsorRows(), inputs, this.rows(), this.mailMock.companyStats());
  }
  /** Research and notes in a company folder, from the fixture's texts (not its jobs, emails or videos). */
  private companyFiles(slug: string): CompanyFile[] {
    const base = `companies/${slug}/`;
    return Object.keys(this.f.texts).filter((rel) => rel.startsWith(base)).map((rel) => rel.slice(base.length))
      .filter((p) => !COMPANY_SKIP.has(p.split("/")[0]!) && !p.split("/").some((seg) => seg.startsWith(".")) && p.split("/").length <= 2)
      .sort().map((p): CompanyFile => ({ path: p, rel: base + p, label: p === "research.md" ? "Company research" : "", at: this.iso(), size: this.f.texts[base + p]!.length, kind: fileKind(p) }));
  }
  /** Test hook: the referral finder's saved connections (import reads `mockNetwork.csv`). */
  readonly mockNetwork = new MockNetwork();
  network = {
    status: () => this.rec("network.status", [], () => this.mockNetwork.status),
    importLinkedIn: (p: string) => this.rec("network.importLinkedIn", [p], () => { const s = this.mockNetwork.import(p, this.iso()); this.emit("settings", "jobs"); return s; }),
    people: (company: string) => this.rec("network.people", [company], () => this.mockNetwork.at(company)),
    forget: () => this.rec("network.forget", [], () => { const s = this.mockNetwork.forget(); this.emit("settings", "jobs"); return s; }),
  };
  companies = {
    list: () => this.rec("companies.list", [], (): CompanyRow[] => this.companyRows()),
    get: (key: string) => this.rec("companies.get", [key], () => {
      const all = this.companyRows();
      const row = all.find((r) => r.slug === key) ?? all.find((r) => r.key === key);
      if (!row) throw new Error("That company isn't in this workspace.");
      const records = row.slug ? this.f.jobs.filter((j) => j.job.company_slug === row.slug).map((j) => j.job) : [];
      const files = row.slug ? this.companyFiles(row.slug) : [];
      const d = buildCompanyDetail(row, this.rows(), records, files, row.slug ? readCompanyContacts(this.f.texts[`companies/${row.slug}/${CONTACTS_FILE}`]) : null);
      // Research age as main works it out (services research.ts): the Researched line, else the file's time.
      const research = files.find((x) => x.path === RESEARCH_FILE);
      return { ...d, research: research ? researchAge(this.f.texts[research.rel] ?? "", research.at, this.now) : null };
    }),
  };

  /** Like the services: mail moves tracking on (a sent email sets the contacted date, a reply sets Replied). */
  private agencyRows(): AgencyRow[] {
    const outreach = { ...this.mailMock.outreach(), today: localDate(this.now) };
    for (const a of this.f.agencies ?? []) {
      const { patch } = agencyActivity(a, outreach.drafts, outreach.replies, outreach.today);
      if (patch) for (const e of applyAgencyPatch(a, patch)) a.timeline.push({ at: this.iso(), ...e, note: e.note || "Found in your mail" });
    }
    return buildAgencyRows(this.f.agencies ?? [], this.rows(), outreach);
  }
  recruiters = {
    list: () => this.rec("recruiters.list", [], (): AgencyRow[] => this.agencyRows()),
    update: (slug: string, patch: AgencyPatch) => this.rec("recruiters.update", [slug, patch], (): AgencyRow => {
      const a = (this.f.agencies ?? []).find((x) => x.slug === slug);
      if (!a) throw new Error("That recruiter isn't in this workspace.");
      const at = this.iso();
      for (const e of applyAgencyPatch(a, agencyPatchArgs(patch))) a.timeline.push({ at, ...e });
      this.emit("recruiters");
      return this.agencyRows().find((r) => r.slug === slug)!;
    }),
    attachResume: (slug: string, id: string, rel: string) => this.rec("recruiters.attachResume", [slug, id, rel], (): { rel: string } => {
      const name = rel.split("/").pop()!;
      const dest = id ? `companies/${slug}/jobs/${id}/application/${name}` : `companies/${slug}/emails/outgoing/${name}`;
      this.f.texts[dest] = this.f.texts[rel] ?? "Your resume (fictional)";
      this.emit("jobs");
      return { rel: dest };
    }),
    mailbox: (slug: string) => this.rec("recruiters.mailbox", [slug], (): { company_slug: string } => {
      const a = (this.f.agencies ?? []).find((x) => x.slug === slug);
      if (!a) throw new Error("That recruiter isn't in this workspace.");
      if (!this.f.companies.some((c) => c.slug === slug)) {
        this.f.companies.push({ name: a.name, slug, sponsor: { status: "unknown", evidence: [], last_checked: "" } });
        this.emit("jobs");
      }
      return { company_slug: slug };
    }),
    suggestion: (slug: string, id: string) => this.rec("recruiters.suggestion", [slug, id], (): { suggestion: DraftSuggestion | null; problem: string } => {
      if (id) this.find(slug, id);
      const rel = id ? actionPaths("recruiter_job_email", { kind: "job", company_slug: slug, id }, {}).outputs[0]! : actionPaths("recruiter_email", { kind: "company", company_slug: slug }, {}).outputs[0]!;
      if (!Object.hasOwn(this.f.texts, rel)) return { suggestion: null, problem: "" };
      try { return { suggestion: { ...parseDraftSuggestion(this.f.texts[rel]!), at: this.actionOutputs.get(rel) ?? this.iso() }, problem: "" }; } catch { return { suggestion: null, problem: SUGGESTION_UNREADABLE }; }
    }),
    attachVariant: (slug: string, variant: string) => this.rec("recruiters.attachVariant", [slug, variant], (): { rel: string } => {
      this.recruiters.mailbox(slug);
      const m = this.variantMeta.get(variant);
      if (!m || !Object.hasOwn(this.f.texts, `${VARIANTS_DIR}/${variant}/resume.md`)) throw new Error("That resume version isn't written yet.");
      const dest = `companies/${slug}/emails/outgoing/Alex Example - Resume - ${m.name.replace(/[^\p{L}\p{N} &,()'-]/gu, " ").replace(/\s+/g, " ").trim()}.pdf`;
      this.f.texts[dest] = "%PDF-1.7 (fictional)";
      this.emit("jobs");
      return { rel: dest };
    }),
    add: (input: AddRecruiterInput) => this.rec("recruiters.add", [input], (): AgencyAddResult => {
      const r = this.saveAdded(addRecruiterArgs(input, localDate(this.now)));
      this.emit("recruiters");
      return r;
    }),
    importList: (text: string) => this.rec("recruiters.importList", [text], (): AgencyImportResult => this.importAgencies(text)),
    // The mock has no files on disk: a picked "file" is read from the fixture's texts by its path.
    importFile: (path: string) => this.rec("recruiters.importFile", [path], (): AgencyImportResult => {
      const text = this.f.texts[path];
      if (text === undefined) throw new Error("That file can't be read.");
      return this.importAgencies(text);
    }),
    unlink: (slug: string, value: string) => this.rec("recruiters.unlink", [slug, value], (): AgencyRow => {
      const a = (this.f.agencies ?? []).find((x) => x.slug === slug);
      if (!a) throw new Error("That recruiter isn't in this workspace.");
      a.email_match = (a.email_match ?? []).filter((x) => x !== value.toLowerCase());
      this.emit("recruiters");
      return this.agencyRows().find((r) => r.slug === slug)!;
    }),
    emails: (slug: string) => this.rec("recruiters.emails", [slug], (): AgencyEmails => {
      const a = (this.f.agencies ?? []).find((x) => x.slug === slug);
      if (!a) throw new Error("That recruiter isn't in this workspace.");
      const m = agencyAddresses(a);
      const theirs = (addr: string) => { const x = addr.toLowerCase(); const d = x.slice(x.lastIndexOf("@") + 1); return m.addresses.has(x) || [...m.domains].some((y) => d === y || d.endsWith(`.${y}`)); };
      const all = this.mailMock.everything();
      const rows = all.rows.filter((r) => r.company_slug === slug || (r.direction === "in" && theirs(r.from.address)));
      return agencyThreads(rows, all.drafts.filter((d) => d.company_slug === slug || d.to.split(",").some((t) => t.trim() && theirs(t.trim()))));
    }),
  };

  /** Like the services' saveAdded: merged into the same agency (by slug, else website host), else a new one waiting for a check. */
  private saveAdded(x: AgencyAddClean): AgencyAddResult {
    const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
    const list = (this.f.agencies ??= []);
    const same = list.find((a) => a.slug === x.slug) ?? (x.website ? list.find((a) => a.website && host(a.website) === host(x.website)) : undefined);
    const at = this.iso();
    const a: AgencyRecordView = same ?? {
      name: x.name, slug: x.slug, website: "", since: null, specialties: [], tags: [], cities: [], hiring_summary: "", about_url: "", city_links: [], linkedin_url: "",
      team_note: { text: "", source_url: "" }, best_contact: { name: "", source_url: "" }, contacts: [], people: [], job_refs: [], favourite: false,
      tracking: { status: "to_contact", contacted_on: "", follow_up_on: "", notes: "" }, timeline: [], sources: [], email_match: [], needs_check: true,
    };
    if (!same) list.push(a);
    if (!a.website && x.website) a.website = x.website;
    for (const c of x.contacts) if (!a.contacts.some((y) => y.value === c.value)) a.contacts.push(c);
    for (const s of x.sources) if (!(a.sources ??= []).some((y) => y.url === s.url && y.name === s.name)) a.sources.push({ ...s, found_at: at });
    a.timeline.push({ at, event: same ? "Added to by you" : "Added by you", note: x.website });
    return { slug: a.slug, name: a.name, created: !same };
  }
  private importAgencies(text: string): AgencyImportResult {
    const { rows, skipped } = parseAgencyLines(text, localDate(this.now));
    const out: AgencyImportResult = { added: [], merged: [], skipped };
    for (const r of rows) { const x = this.saveAdded(r); (x.created ? out.added : out.merged).push(x); }
    this.emit("recruiters");
    return out;
  }

  searches = {
    list: () => this.rec("searches.list", [], (): SearchList => {
      const cutoff = new Date(this.now.getTime() - 7 * 86_400_000).toISOString();
      const rows = [...this.f.searches].sort((a, b) => b.at.localeCompare(a.at)).map((s) => ({ ...s, mode: (s as { mode?: SearchRow["mode"] }).mode ?? "", recent: s.at >= cutoff }));
      return { rows, sites: [...new Set(rows.map((r) => r.site))].sort(compareBoardSites) };
    }),
  };

  /** "Open JobCairn at login" in the preview: remembered for the session only. */
  openAtLogin = false;
  private scheduleView = (): ScheduleView => {
    const s = cleanSchedule((this.f.search as { schedule?: unknown }).schedule);
    const n = nextRun(s, this.now);
    return { schedule: s, next_run_at: n ? (n.getTime() < this.now.getTime() ? this.now : n).toISOString() : "", open_at_login: this.openAtLogin };
  };
  schedule = {
    get: () => this.rec("schedule.get", [], (): ScheduleView => this.scheduleView()),
    save: (s: SearchSchedule, openAtLogin?: boolean) => this.rec("schedule.save", [s, openAtLogin], (): ScheduleView => {
      const cur = cleanSchedule((this.f.search as { schedule?: unknown }).schedule);
      const next = cleanSchedule({ ...s, since: s.mode === "off" ? "" : this.now.toISOString(), runs: 0, searched_at: cur.searched_at, history: cur.history });
      this.f.search = { ...this.f.search, schedule: next } as typeof this.f.search;
      if (openAtLogin !== undefined) this.openAtLogin = openAtLogin;
      this.emit("settings");
      return this.scheduleView();
    }),
  };

  settings = {
    get: (kind: SettingsKind) => this.rec("settings.get", [kind], (): SettingsData => ({ kind, fields: this.f.fields[kind], values: this.f[kind] })),
    save: (kind: SettingsKind, changes: SettingsChange[]) => this.rec("settings.save", [kind, changes], (): SettingsData => {
      const fields = this.f.fields[kind].filter((x) => x.type !== "object");
      const next = clone(this.f[kind]);
      for (const ch of changes) {
        const field = fields.find((x) => x.path === ch.path);
        const customLength = kind === "integrations" && VIDEO_LENGTH_PATH.test(ch.path) && this.videoMockHost.customTypes.some((t) => videoLengthPath(t.id) === ch.path);
        if (customLength && !isDefaultLength(ch.value)) throw new Error("A default length must be whole seconds from 0 to 600.");
        if (!field && !customLength) throw new Error(`can't change ${ch.path}`);
        if (field?.pattern && typeof ch.value === "string" && !new RegExp(field.pattern).test(ch.value)) throw new Error(`${field.label}: has an invalid format`);
        if (kind === "search" && ch.path === "search_deadline" && typeof ch.value === "string" && ch.value !== "" && !isCalendarDate(ch.value)) throw new Error("Search deadline must be a real date, like 2026-03-31.");
        setPath(next, ch.path, ch.value);
      }
      this.f[kind] = next;
      this.emit(...(kind === "profile" ? (["settings", "jobs", "home"] as ChangeArea[]) : (["settings"] as ChangeArea[])));
      return { kind, fields: this.f.fields[kind], values: next };
    }),
  };

  /** "Fill from my resume" as the preview plays it: every resume reads as the same fictional one. */
  resumeFill: ResumeFillState | null = null;
  /** What a dropped resume "contains". Tests may change it. */
  mockResume: ResumeFields = {
    name: "Alex Example", email: "alex@example.com", phone: "+61 491 570 006", city: "Sampletown NSW",
    links: ["https://www.linkedin.com/in/alex-example", "https://github.com/alexexample"],
  };
  private suggested: TargetSuggestions | null = null;

  private readMockResume(file: string): ResumeRead {
    const name = file.split(/[\\/]/).pop() ?? "resume";
    if (/\.doc$/i.test(name)) throw new Error(`"${name}" is an older Word file (.doc). Save it as .docx or PDF, then try again.`);
    if (!/\.(pdf|docx|md|markdown|txt)$/i.test(name)) throw new Error(`"${name}" isn't a resume this app can read. Use a PDF, Word (.docx), Markdown or text file.`);
    const kind = /\.pdf$/i.test(name) ? "pdf" : /\.docx$/i.test(name) ? "word" : /\.(md|markdown)$/i.test(name) ? "markdown" : "text";
    return { file: name, kind, fields: clone(this.mockResume) };
  }

  private fillMockProfile(file: string, values: ResumeValues, overwrite: ResumeFieldKey[]): ResumeFillState {
    if (!this.isOpen) throw new Error("No workspace is open.");
    const name = file.split(/[\\/]/).pop() ?? "resume";
    const next = clone(this.f.profile);
    const filled: ResumeFieldKey[] = [];
    const kept: ResumeFieldKey[] = [];
    for (const key of RESUME_FIELD_KEYS) {
      const raw = values[key];
      if (raw === undefined) continue;
      const v = Array.isArray(raw) ? raw.filter(Boolean) : String(raw).trim();
      if (Array.isArray(v) ? !v.length : !v) continue;
      const cur = getPath(next, RESUME_FIELD_PATHS[key]);
      const empty = Array.isArray(cur) ? !cur.length : !String(cur ?? "").trim();
      if (empty || overwrite.includes(key)) { setPath(next, RESUME_FIELD_PATHS[key], v); filled.push(key); }
      else if (JSON.stringify(cur) !== JSON.stringify(v)) kept.push(key);
    }
    this.f.profile = next;
    const kind = /\.pdf$/i.test(name) ? "pdf" : /\.docx$/i.test(name) ? "word" : /\.(md|markdown)$/i.test(name) ? "markdown" : "text";
    this.resumeFill = { at: this.iso(), file: name, kind, filled, kept, seen: false };
    this.emit("settings", "jobs", "home");
    return this.resumeFill;
  }

  profile = {
    readResume: (file: string) => this.rec("profile.readResume", [file], (): ResumeRead => this.readMockResume(file)),
    fillFromResume: (file: string, values: ResumeValues, overwrite: ResumeFieldKey[]) => this.rec("profile.fillFromResume", [file, values, overwrite], (): ResumeFillState => this.fillMockProfile(file, values, overwrite)),
    fillState: () => this.rec("profile.fillState", [], () => (this.isOpen ? this.resumeFill : null)),
    markFillSeen: () => this.rec("profile.markFillSeen", [], () => {
      if (this.resumeFill && !this.resumeFill.seen) { this.resumeFill = { ...this.resumeFill, seen: true }; this.emit("settings", "home"); }
      return this.resumeFill;
    }),
    suggestions: () => this.rec("profile.suggestions", [], () => this.suggested),
  };

  privacy = {
    get: () => this.rec("privacy.get", [], () => this.privacyState()),
    moveBack: (folder: LockableDir) => this.rec("privacy.moveBack", [folder], () => {
      const p = this.problems.find((x) => x.folder === folder && x.found_at);
      if (!p) throw new Error(`${PRODUCT_NAME} doesn't know where ${folder} went, so it can't move it back.`);
      this.problems = this.problems.filter((x) => x !== p);
      this.log("Moved back", `${p.found_at} to ${folder}`);
      this.emit("privacy", "home");
      return this.privacyState();
    }),
    acceptFolders: () => this.rec("privacy.acceptFolders", [], () => {
      // Like the services: a folder found elsewhere stays locked there and stays on the list until moved back.
      this.problems = this.problems.filter((p) => p.found_at).map((p) => ({ ...p, kind: "elsewhere" as const }));
      this.log("Locked folders accepted", this.locked.join(", "));
      this.emit("privacy", "home");
      return this.privacyState();
    }),
    setLocked: (folder: LockableDir, locked: boolean) => this.rec("privacy.setLocked", [folder, locked], () => {
      this.locked = (["me/identity", "me/employment"] as LockableDir[]).filter((d) => (d === folder ? locked : this.locked.includes(d)));
      this.grants = this.grants.filter((g) => g.folder !== folder);
      this.log(locked ? "Locked" : "Unlocked", folder);
      this.emit("privacy");
      return this.privacyState();
    }),
    allow: (requestId: string, minutes: number) => this.rec("privacy.allow", [requestId, minutes], () => {
      const r = this.f.requests.find((x) => x.id === requestId);
      if (!r) throw new Error(`no request ${requestId}`);
      if (r.status !== "pending") throw new Error(`request ${requestId} is ${r.status}; it can't become allowed`);
      const until = new Date(this.now.getTime() + minutes * 60_000).toISOString();
      Object.assign(r, { status: "allowed", minutes, expires_at: until, decided_at: this.iso() } satisfies Partial<AccessRequestView>);
      // A folder that is already unlocked needs no grant; the request is still recorded as
      // allowed. Mirrors packages/services/src/privacy.ts's allow().
      if (this.locked.includes(r.folder)) {
        this.grants = [...this.grants.filter((g) => g.folder !== r.folder), { folder: r.folder, until, request_id: r.id }];
      }
      this.log("Allowed once", `${r.folder} for ${minutes} minutes`);
      this.emit("privacy", "home");
      return this.privacyState();
    }),
    deny: (requestId: string) => this.rec("privacy.deny", [requestId], () => {
      const r = this.f.requests.find((x) => x.id === requestId);
      if (!r) throw new Error(`no request ${requestId}`);
      if (r.status !== "pending") throw new Error(`request ${requestId} is ${r.status}; it can't become denied`);
      Object.assign(r, { status: "denied", decided_at: this.iso() });
      this.log("Denied", r.folder);
      this.emit("privacy", "home");
      return this.privacyState();
    }),
    revoke: (folder: LockableDir) => this.rec("privacy.revoke", [folder], () => {
      this.grants = this.grants.filter((g) => g.folder !== folder);
      this.log("Re-locked", folder);
      this.emit("privacy");
      return this.privacyState();
    }),
  };

  approvals = {
    list: () => this.rec("approvals.list", [], () => this.allApprovals().map((a) => this.mailMock.withEmail(this.view(a)))),
    approve: (id: string, digest: string) => this.rec("approvals.approve", [id, digest], () => {
      const a = this.allApprovals().find((x) => x.id === id);
      if (!a) throw new Error(`no approval ${id}`);
      if (mockDigest(a) !== digest) throw new Error("This request changed after you opened it. Review it again.");
      if (a.status !== "pending") throw new Error(`approval ${id} is ${a.status}; it can't become approved`);
      a.status = "approved";
      a.decided_at = this.iso();
      if (a.action === "email_send") {
        // Like the services: a send that can't run fails the approval instead of throwing.
        let note: string | null;
        try { note = this.mailMock.sendApproved(a); } catch (e) { note = (e as Error).message; a.status = "failed"; }
        // No final reply from Gmail: the approval stays "approved" and "not sure" (see mail.send).
        if (note !== null) { a.result_note = note; if (a.status !== "failed") a.status = "done"; }
        this.emit("approvals", "jobs", "home", "mail");
        return this.mailMock.withEmail(this.view(a));
      }
      const p = a.payload as { company_slug: string; id: string; status?: JobStatus; note?: string; url?: string };
      const j = this.find(p.company_slug, p.id);
      if (a.action === "status_change") { this.setJobStatus(j, p.status!, p.note ?? ""); a.result_note = `Status set to ${p.status}`; }
      if (a.action === "apply_handoff") {
        // Mirrors services' approve(): only a url that passes the same safe-link rule
        // ever gets "opened", so the mock can't diverge from the real handler and claim
        // to have opened a link it actually refused.
        const url = typeof p.url === "string" && isSafeHttpsUrl(p.url) ? p.url : "";
        if (url) this.opened.push(url);
        this.revealed.push(`companies/${p.company_slug}/jobs/${p.id}/application`);
        this.event(j, "Handed off", url);
        a.result_note = url ? "Opened the apply page and the files" : "Opened the files";
      }
      a.status = "done";
      this.emit("approvals", "jobs", "home");
      return this.view(a);
    }),
    decline: (id: string, note: string) => this.rec("approvals.decline", [id, note], () => {
      const a = this.allApprovals().find((x) => x.id === id);
      if (!a) throw new Error(`no approval ${id}`);
      if (a.status !== "pending") throw new Error(`approval ${id} is ${a.status}; it can't become declined`);
      Object.assign(a, { status: "declined", decided_at: this.iso(), result_note: note });
      this.emit("approvals", "home");
      return this.view(a);
    }),
  };

  secrets = {
    status: (name: SecretName) => this.rec("secrets.status", [name], (): SecretStatus => ({ name, available: this.secretsAvailable, set: this.isOpen && this.secretsHere().has(name) })),
    set: (name: SecretName, value: string) => this.rec("secrets.set", [name, value.length ? "<redacted>" : ""], (): SecretStatus => {
      if (!this.secretsAvailable) throw new Error("Secure storage isn't available on this computer, so the secret was not saved.");
      if (!this.isOpen) throw new Error("Open a workspace first. Secrets are kept separately for each workspace.");
      // Like the services: the Gmail password is stored only after it passes a test (Settings > Email).
      if (name === "gmail_app_password") this.mailMock.replacePassword(value);
      this.secretsHere().add(name);
      return { name, available: true, set: true };
    }, [name, value]),
    remove: (name: SecretName) => this.rec("secrets.remove", [name], (): SecretStatus => {
      // Like the services: removing only the Gmail password would leave an account without a credential.
      if (name === "gmail_app_password") throw new Error("Use Disconnect in Settings > Email to remove the Gmail app password.");
      this.secretsHere().delete(name);
      return { name, available: this.secretsAvailable, set: false };
    }),
  };

  links = {
    // `validateArgs` already enforces https-only (httpsUrl) before this handler runs, so by
    // the time we get here the URL is guaranteed https and safe to record and "open".
    open: (url: string) => this.rec("links.open", [url], () => {
      this.opened.push(url);
      return true;
    }),
  };

  /** The Claude Code engine stand-in: tests drive runs with advance, finish and fail. Declared before `claude`, which spreads its methods. */
  readonly claudeSim = new MockClaude({
    rec: (m, a, fn) => this.rec(m, a, fn), emit: () => this.emit("claude"), now: () => this.now,
    outputs: (id, t) => this.actionView(id, t).outputs.map((o) => o.path), writeOutputs: (id, t) => this.simulateActionOutput(id, t),
    workRights: () => this.status(), mapRequest: (id, t, req) => this.mapRequest(id, t, req),
  });

  claude = {
    openDesktop: () => this.rec("claude.openDesktop", [], () => this.claudeDesktop),
    status: (id: ActionId, target: ActionTarget) => this.rec("claude.status", [id, target], () => this.actionView(id, target)),
    prepare: (id: ActionId, target: ActionTarget, open: boolean) => this.rec("claude.prepare", [id, target, open], (): ActionPrepared => {
      if (!claudeWrites(id)) throw new Error(TEMPLATE_ONLY);
      const t = ownTarget(id, target);
      const before = this.actionView(id, t);
      if (before.status === "blocked") throw new Error(`Do "${before.blockedBy.map((r) => ACTIONS[r].label).join('" and "')}" first.`);
      const info = { ...this.actionInfo(t), now: this.iso() };
      const video = ACTIONS[id].group === "video";
      const open_ = before.status === "pending" ? this.actionRequests.get(before.key) : undefined;
      const reuse = video && open_?.folder ? videoFolderN(id, t, { ...info, now: open_.at }, open_.folder) : null;
      const n = video ? reuse ?? nextVideoFolder(id, t, info, this.folders)?.n ?? null : 1;
      if (n === null) throw new Error("There are too many videos in this folder. Delete some old ones first.");
      const saved = this.savedFor(id, t);
      const request = saved ? { options: saved, note: "" } : null;
      // Like main: find jobs takes breadth and sponsorship-only from the saved search settings.
      const prompt = buildActionPrompt(id, t, { ...info, n }, id === "find_jobs" ? withSavedSearchOptions(request, searchPrefsFrom(this.f.profile, this.f.search), this.status()) : request);
      this.actionRequests.set(before.key, { at: this.iso(), folder: video ? actionPaths(id, t, { ...info, n }).folder : "" });
      if (this.clipboardWorks) this.copied.push(prompt);
      this.emit("jobs", "learn", "searches");
      return { ...this.actionView(id, t), prompt, copied: this.clipboardWorks, opened: open && this.claudeDesktop };
    }),
    ...this.claudeSim.methods(),
    compose: (id: ActionId, target: ActionTarget) => this.rec("claude.compose", [id, target], () => this.composeView(id, target)),
    saveOptions: (id: ActionId, target: ActionTarget, options: Record<string, OptionValue>) => this.rec("claude.saveOptions", [id, target, options], () => {
      const t = ownTarget(id, target);
      const chips = this.skillChips(id, t);
      const clean: Record<string, OptionValue> = { ...options };
      for (const o of optionsFor(id, this.status())) if (o.kind === "chips" && o.suggest === "skills" && Array.isArray(clean[o.key])) clean[o.key] = (clean[o.key] as string[]).filter((c) => chips.includes(c));
      this.savedOptions.set(actionKey(id, t), validateOptions(id, clean, this.status()));
      return this.composeView(id, t);
    }),
  };

  private composeView(id: ActionId, target: ActionTarget): ComposeView {
    const t = ownTarget(id, target);
    const info = { ...this.actionInfo(t), now: this.iso() };
    const n = ACTIONS[id].group === "video" ? videoFolderN(id, t, info, this.actionView(id, t).folder) ?? 1 : 1;
    const saved = this.savedFor(id, t);
    return { info: { ...info, n }, options: saved ? structuredClone(saved) : defaultOptions(id, this.status()), saved: !!saved, suggestions: this.skillChips(id, t) };
  }
  /** Saved options still allowed for today's work-rights status (as the services re-check them on read). */
  private savedFor(id: ActionId, t: ActionTarget): Record<string, OptionValue> | undefined {
    const raw = this.savedOptions.get(actionKey(id, t));
    const defs = optionsFor(id, this.status());
    if (!raw || !defs.length) return undefined;
    const keep: Record<string, OptionValue> = {};
    for (const d of defs) if (raw[d.key] !== undefined && optionValueOk(id, d.key, raw[d.key], this.status())) keep[d.key] = raw[d.key]!;
    try { return validateOptions(id, keep, this.status()); } catch { return undefined; }
  }
  private skillChips(id: ActionId, t: ActionTarget): string[] {
    if (!optionsFor(id, this.status()).some((o) => o.kind === "chips" && o.suggest === "skills")) return [];
    const job = deriveTarget(t, "job");
    const fit = job?.kind === "job" ? this.find(job.company_slug, job.id).job.scores.fit : null;
    return skillSuggestions(fit, getPath(this.f.profile, "targets.keywords"));
  }

  docs = {
    state: (slug: string, id: string) => this.rec("docs.state", [slug, id], () => this.docsState(slug, id)),
    export: (slug: string, id: string, sources: ExportSource[], formats: ExportFormat[], overwrite: boolean) =>
      this.rec("docs.export", [slug, id, sources, formats, overwrite], (): ExportState => {
        const st = this.docsState(slug, id);
        const missing = sources.filter((s) => !st.sources.find((x) => x.source === s)?.exists);
        if (missing.length) throw new Error(`${missing.map((s) => `application/${s}.md`).join(" and ")} isn't there yet. Prepare the application first.`);
        const clash = st.files.filter((f) => f.exists && sources.includes(f.source) && formats.includes(f.format));
        if (clash.length && !overwrite) throw new Error(`Already exported: ${clash.map((f) => f.name).join(", ")}. Choose Replace to write them again.`);
        const written: string[] = [];
        for (const s of EXPORT_SOURCES.filter((x) => sources.includes(x))) for (const f of EXPORT_FORMATS.filter((x) => formats.includes(x))) {
          this.exportsMade.set(exportRel(slug, id, s, f), { size: f === "pdf" ? 48_000 : 9_000, at: this.iso() });
          written.push(`${s}.${f}`);
        }
        this.event(this.find(slug, id), "Exported", written.join(", "));
        this.emit("jobs");
        return this.docsState(slug, id);
      }),
  };

  tts = {
    status: () => this.rec("tts.status", [], (): TtsStatus => this.ttsStatusNow()),
    speak: (text: string, options: TtsOptions, source: string, requestId: string) => this.rec("tts.speak", [text, options, source, requestId], (): TtsSpeakResult => {
      if (source) {
        const lockedIn = this.lockedNow().find((d) => source === d || source.startsWith(`${d}/`));
        if (lockedIn) throw new Error(`${lockedIn} is locked. Allow it once in Privacy first.`);
      }
      const spoken = speakable(text);
      if (!spoken) throw new Error("There's nothing to read aloud here.");
      if (this.ttsEngine === "none") throw new Error(`No voice is set up on this computer. ${SETUP_AGAIN}`);
      const mac = options.engine === "macos_say";
      const engine = mac ? "macos_say" : this.ttsEngine;
      const key = `${options.voice}|${options.lang}|${engine}|${spoken}`;
      const cached = this.ttsCache.has(key);
      this.ttsCache.add(key);
      return { url: silentWavUrl(spoken), cached, engine, fellBack: !mac && engine !== "supertonic" };
    }).then((r) => (r.cached || !this.ttsDelayMs ? r : new Promise<TtsSpeakResult>((resolve, reject) => {
      const t = setTimeout(() => { this.ttsPending.delete(requestId); resolve(r); }, this.ttsDelayMs);
      this.ttsPending.set(requestId, () => { clearTimeout(t); reject(new Error("Reading aloud was stopped.")); });
    }))),
    cancel: (requestId: string) => this.rec("tts.cancel", [requestId], () => {
      const stop = this.ttsPending.get(requestId);
      this.ttsPending.delete(requestId);
      stop?.();
      return !!stop;
    }),
    previews: () => this.rec("tts.previews", [], (): TtsPreviews => this.ttsPreviewList()),
    generatePreviews: (lang: TtsLang) => this.rec("tts.generatePreviews", [lang], (): TtsPreviews => {
      if (this.ttsEngine !== "supertonic") throw new Error(`Voice previews need the Supertonic voice. ${SETUP_AGAIN}`);
      this.ttsPreviewVoices.add("F4");
      this.emit("settings");
      return this.ttsPreviewList();
    }),
    previewVoice: (voice: TtsVoice, lang: TtsLang) => this.rec("tts.previewVoice", [voice, lang], (): TtsPreviews => {
      if (this.ttsEngine !== "supertonic") throw new Error(`Voice previews need the Supertonic voice. ${SETUP_AGAIN}`);
      this.ttsPreviewVoices.add(voice);
      this.emit("settings");
      return this.ttsPreviewList();
    }),
    activity: () => this.rec("tts.activity", [], (): TtsActivity => ({ voice: this.ttsPending.size ? "busy" : "ready", previewsLeft: 0 })),
    clearCache: () => this.rec("tts.clearCache", [], () => { const n = this.ttsCache.size; this.ttsCache.clear(); return n; }),
    // The mock never touches the network: "downloading" just flips the engine to ready.
    downloadVoice: () => this.rec("tts.downloadVoice", [], (): TtsStatus => {
      this.ttsNeedsDownload = false;
      this.ttsEngine = "supertonic";
      return this.ttsStatusNow();
    }),
    // The mock never installs anything real: it just flips to "the package is here, the model still isn't".
    installVoice: () => this.rec("tts.installVoice", [], (): TtsStatus => {
      this.ttsNeedsInstall = false;
      this.ttsNeedsDownload = true;
      this.ttsEngine = "macos_say";
      return this.ttsStatusNow();
    }),
    stopVoiceWork: () => this.rec("tts.stopVoiceWork", [], () => false),
  };
  private ttsStatusNow(): TtsStatus {
    return (
      this.ttsNeedsDownload
        ? { engine: "macos_say", text: "The Supertonic voice isn't downloaded yet.", hint: "Download it in Settings > Voice. Until then the macOS voice reads aloud.", languages: ["en"], languagesNote: "Only English is offered until the Supertonic voice is set up.", needsDownload: true }
        : this.ttsNeedsInstall
        ? { engine: "macos_say", text: "The natural voice (Supertonic) isn't set up on this Mac yet.", hint: "Set it up in Settings > Voice. It installs once, then reads offline for free.", languages: ["en"], languagesNote: "Only English is offered until the Supertonic voice is set up.", needsInstall: true }
        : this.ttsEngine === "supertonic"
        ? { engine: "supertonic", text: "Supertonic voice is ready. It runs on this Mac, offline.", hint: "", languages: ["en", "de", "es", "fr", "ja", "ko", "pt"], languagesNote: "" }
        : this.ttsEngine === "macos_say"
          ? { engine: "macos_say", text: "Using the macOS voice. Supertonic isn't set up yet.", hint: "For the Supertonic voice, install Python 3.11 to 3.14 in Settings > Voice, then install the voice.", languages: ["en"], languagesNote: "Only English is offered until the Supertonic voice is set up." }
          : { engine: "none", text: "No voice is set up on this computer.", hint: SETUP_AGAIN, languages: ["en"], languagesNote: "" });
  }
  private ttsPreviewList(): TtsPreviews {
    const voices = TTS_VOICES.map((voice) => ({ voice, label: voiceLabel(voice), url: this.ttsPreviewsMade || this.ttsPreviewVoices.has(voice) ? silentWavUrl("Hi, I'm your study voice.") : null }));
    return { voices, missing: voices.filter((v) => !v.url).length };
  }
  resume = {
    load: (ref: ResumeRef, file: string) => this.rec("resume.load", [ref, file], () => this.resumeState(ref, file)),
    save: (ref: ResumeRef, file: string, markdown: string, style: ResumeStyle, digest: string, replacing: boolean) =>
      this.rec("resume.save", [ref, file, markdown, style, digest, replacing], (): ResumeState => {
        const r = this.resumeOf(ref, file);
        this.checkDigest(r, digest);
        if (markdown !== r.md) {
          if (replacing) this.addVersion(r, r.md, "replaced");
          this.writeResume(r, markdown, "autosave");
        }
        r.style = parseResumeStyle(style);
        this.emit("jobs");
        return this.resumeState(ref, file);
      }),
    version: (ref: ResumeRef, file: string, versionId: string) => this.rec("resume.version", [ref, file, versionId], () => {
      const v = this.resumeOf(ref, file).versions.find((x) => x.id === versionId);
      if (!v) throw new Error("That version isn't there any more.");
      return v.text;
    }),
    restore: (ref: ResumeRef, file: string, versionId: string, digest: string) => this.rec("resume.restore", [ref, file, versionId, digest], (): ResumeState => {
      const r = this.resumeOf(ref, file);
      this.checkDigest(r, digest);
      const v = r.versions.find((x) => x.id === versionId);
      if (!v) throw new Error("That version isn't there any more.");
      this.writeResume(r, v.text, "restore");
      if (ref.kind === "job") this.event(this.find(ref.company_slug, ref.id), "Resume restored", `A version from ${v.at.slice(0, 10)}`);
      this.emit("jobs");
      return this.resumeState(ref, file);
    }),
    suggestion: (ref: ResumeRef, file: string, decision: SuggestionDecision, digest: string) =>
      this.rec("resume.suggestion", [ref, file, decision, digest], (): ResumeState => {
        if (ref.kind !== "job") throw new Error("Claude's suggestions are for a job's tailored resume.");
        const r = this.resumeOf(ref, file);
        const p = this.suggestedRel(ref.company_slug, ref.id);
        const text = file === SUGGESTED_FOR ? this.f.texts[p] : undefined;
        if (text === undefined) throw new Error("Claude's suggestion isn't there any more. Reload to see the latest.");
        if (decision === "accept") {
          this.checkDigest(r, digest);
          if (text !== r.md) this.writeResume(r, text, "ai");
          this.event(this.find(ref.company_slug, ref.id), "Resume updated", "Accepted Claude's rewrite");
        } else if (decision === "keep") {
          if (!r.versions.length) this.addVersion(r, r.md, "original");
          this.addVersion(r, text, "replaced");
        }
        delete this.f.texts[p];
        this.actionOutputs.delete(p);
        this.emit("jobs");
        return this.resumeState(ref, file);
      }),
    download: (ref: ResumeRef, file: string, format: ResumeDownload) => this.rec("resume.download", [ref, file, format], (): DownloadResult => {
      const r = this.resumeOf(ref, file);
      const name = ref.kind === "job" ? `Alex Example - ${this.find(ref.company_slug, ref.id).company.name} - Resume.${format}` : `Alex Example - Resume - ${this.variantMeta.get(ref.variant)!.name}.${format}`;
      if (!this.saveDialog) return { saved: false, name };
      const m = parseResume(r.md);
      this.downloads.push({ name, format, text: format === "txt" ? toPlainText(m, r.style.hidden) : visibleMarkdown(m, r.style.hidden) });
      return { saved: true, name };
    }),
    copy: (ref: ResumeRef, file: string, format: ResumeCopy) => this.rec("resume.copy", [ref, file, format], () => {
      const r = this.resumeOf(ref, file);
      const m = parseResume(r.md);
      if (!this.clipboardWorks) return false;
      this.copied.push(format === "md" ? visibleMarkdown(m, r.style.hidden) : toPlainText(m, r.style.hidden));
      return true;
    }),
  };

  resumes = {
    list: () => this.rec("resumes.list", [], (): ResumeLibrary => {
      const base = this.filed.filter((e) => e.to.startsWith("me/resumes/") && !/ \(text\)\.txt$/.test(e.to)).map((e) => ({ rel: e.to, name: basename(e.to), at: e.at }));
      const tailored = this.f.jobs.filter((j) => Object.hasOwn(this.f.texts, `companies/${j.job.company_slug}/jobs/${j.job.id}/application/resume.md`)).map((j) => {
        const rel = `companies/${j.job.company_slug}/jobs/${j.job.id}/application/resume.md`;
        return { company_slug: j.job.company_slug, id: j.job.id, title: j.job.title, company_name: j.company.name, status: j.job.status, at: this.resumeDocs.get(`${j.job.company_slug}/${j.job.id}/resume.md`)?.savedAt ?? this.actionOutputs.get(rel) ?? j.job.found_at };
      });
      const variants = [...this.variantMeta].map(([variant, m]) => {
        const rel = `${VARIANTS_DIR}/${variant}/resume.md`;
        const ready = Object.hasOwn(this.f.texts, rel);
        return { variant, name: m.name, created_at: m.created_at, at: this.resumeDocs.get(`variant:${variant}/resume.md`)?.savedAt ?? this.actionOutputs.get(rel) ?? m.created_at, ready };
      });
      return { base, tailored: tailored.sort((a, b) => b.at.localeCompare(a.at)), variants: variants.sort((a, b) => b.at.localeCompare(a.at)) };
    }),
    newVariant: (name: string) => this.rec("resumes.newVariant", [name], () => {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 52).replace(/-+$/, "") || "version";
      let variant = base;
      for (let n = 2; this.variantMeta.has(variant); n++) variant = `${base}-${n}`;
      this.variantMeta.set(variant, { name: name.replace(/\s+/g, " ").trim(), created_at: this.iso() });
      this.emit("jobs");
      return { variant };
    }),
    duplicate: (source: ResumeItemRef, name: string) => this.recAsync("resumes.duplicate", [source, name], async () => {
      const from = source.kind === "base" ? null : this.resumeOf(source, "resume.md");
      const md = source.kind === "base" ? this.f.texts[source.rel] ?? `# Alex Example\n\nText read from ${basename(source.rel)} (fictional).\n` : from!.md;
      const { variant } = await this.resumes.newVariant(name);
      this.f.texts[`${VARIANTS_DIR}/${variant}/resume.md`] = md;
      this.actionOutputs.set(`${VARIANTS_DIR}/${variant}/resume.md`, this.iso());
      if (from) this.resumeOf({ kind: "variant", variant }, "resume.md").style = { ...from.style };
      this.emit("jobs");
      return { variant };
    }),
    remove: (target: ResumeItemRef) => this.rec("resumes.remove", [target], () => this.trashMove([{ kind: "resume", ref: target }])[0]!),
  };


  // ---- Delete (the workspace trash) ---------------------------------------------------------------------------------
  /** What a delete took, newest first, with how to put it back (like .backup/trash, kept 30 days). */
  private binned: { item: TrashItem; restore: () => void; taken: () => boolean; companyGone?: () => boolean }[] = [];
  private trashSeq = 0;
  /** Like services' plan: the name, what goes with it, why it can't go now, and the move itself. */
  private trashPlan(t: TrashTarget): { kind: TrashTargetKind; title: string; also: string; note: string; blocked: string | null; take: () => { restore: () => void; taken: () => boolean; companyGone?: () => boolean } } {
    const runs = this.claudeSim.runs.filter((r) => isActiveRun(r.status));
    const on = (slug: string, id?: string) => runs.some((r) => { const x = r.target as { company_slug?: string; id?: string }; return x.company_slug === slug && (id === undefined || x.id === id); });
    const waiting = (slug: string, id?: string) => this.f.approvals.some((a) => a.status === "pending" && a.payload.company_slug === slug && (id === undefined || a.payload.id === id));
    const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
    const mailOf = (slug: string) => this.mailMock.companyStats().find((m) => m.company_slug === slug)?.count ?? 0;
    switch (t.kind) {
      case "job": {
        const j = this.f.jobs.find((x) => x.job.company_slug === t.company_slug && x.job.id === t.id);
        if (!j) throw new Error("That job isn't there any more.");
        const blocked = on(t.company_slug, t.id) ? "Claude is working on this job. Wait for it to finish, or cancel it in Activity."
          : this.videoMock.busyUnder(`companies/${t.company_slug}/jobs/${t.id}`) ? "A video for this job is being made. Wait for it to finish, or cancel it."
          : waiting(t.company_slug, t.id) ? "This job has something waiting for your approval. Approve or decline it first." : null;
        return {
          kind: "job", title: `${j.job.title} at ${j.company.name}`, also: "", note: "", blocked,
          take: () => {
            this.f.jobs = this.f.jobs.filter((x) => x !== j);
            return {
              restore: () => { this.f.jobs.push(j); }, taken: () => this.f.jobs.some((x) => x.job.company_slug === t.company_slug && x.job.id === t.id),
              companyGone: () => !this.f.companies.some((c) => c.slug === t.company_slug),
            };
          },
        };
      }
      case "company": {
        const c = this.f.companies.find((x) => x.slug === t.company_slug);
        if (!c) throw new Error("That company isn't there any more.");
        const jobs = this.f.jobs.filter((x) => x.job.company_slug === t.company_slug);
        const mail = mailOf(t.company_slug);
        const blocked = on(t.company_slug) ? "Claude is working on this company or one of its jobs. Wait for it to finish, or cancel it in Activity."
          : this.videoMock.busyUnder(`companies/${t.company_slug}`) ? "A video for this company is being made. Wait for it to finish, or cancel it."
          : waiting(t.company_slug) ? "One of its jobs has something waiting for your approval. Approve or decline it first." : null;
        return {
          kind: "company", title: c.name, also: jobs.length ? `its ${plural(jobs.length, "job")}` : "", blocked,
          note: mail ? `Its ${plural(mail, "email")} stay in Mail, under To sort.` : "",
          take: () => {
            this.f.companies = this.f.companies.filter((x) => x !== c);
            this.f.jobs = this.f.jobs.filter((x) => !jobs.includes(x));
            return { restore: () => { this.f.companies.push(c); this.f.jobs.push(...jobs); }, taken: () => this.f.companies.some((x) => x.slug === t.company_slug) };
          },
        };
      }
      case "job_file": {
        const j = this.f.jobs.find((x) => x.job.company_slug === t.company_slug && x.job.id === t.id);
        if (!j) throw new Error("That job isn't there any more.");
        if (t.path === "job.json" || t.path === "jd.md" || t.path.startsWith("emails/")) throw new Error("That file belongs to the job itself, so it can't be deleted on its own.");
        const key = `${t.company_slug}/${t.id}`;
        const own = j.job.files.find((f) => f.path === t.path);
        const app = (this.appFiles.get(key) ?? []).find((f) => f.path === t.path);
        if (!own && !app) throw new Error("That file isn't one of this job's files.");
        const label = (own?.label ?? app?.label ?? "") || basename(t.path);
        return {
          kind: "job_file", title: label === basename(t.path) ? basename(t.path) : label, also: "", note: "", blocked: on(t.company_slug, t.id) ? "Claude is working on this job. Wait for it to finish, or cancel it in Activity." : null,
          take: () => {
            if (own) j.job.files = j.job.files.filter((f) => f !== own);
            if (app) this.appFiles.set(key, (this.appFiles.get(key) ?? []).filter((f) => f !== app));
            this.event(j, "Deleted", label);
            return {
              restore: () => { if (own) j.job.files.push(own); if (app) this.appFiles.set(key, [...(this.appFiles.get(key) ?? []), app]); this.event(j, "Restored", label); },
              taken: () => j.job.files.some((f) => f.path === t.path) || (this.appFiles.get(key) ?? []).some((f) => f.path === t.path),
              companyGone: () => !this.f.jobs.includes(j),
            };
          },
        };
      }
      case "resume": {
        const target = t.ref;
        if (target.kind === "base") {
          const e = this.filed.find((x) => x.to === target.rel);
          if (!e) throw new Error("That resume isn't there any more.");
          return { kind: "resume", title: basename(target.rel), also: "", note: "", blocked: null, take: () => {
            this.filed = this.filed.filter((x) => x !== e);
            return { restore: () => { this.filed.push(e); }, taken: () => this.filed.some((x) => x.to === target.rel) };
          } };
        }
        const rel = target.kind === "variant" ? `${VARIANTS_DIR}/${target.variant}/resume.md` : `companies/${target.company_slug}/jobs/${target.id}/application/resume.md`;
        const meta = target.kind === "variant" ? this.variantMeta.get(target.variant) : undefined;
        if (target.kind === "variant" ? !meta : !Object.hasOwn(this.f.texts, rel)) throw new Error("That resume isn't there any more.");
        const job = target.kind === "job" ? this.f.jobs.find((x) => x.job.company_slug === target.company_slug && x.job.id === target.id) : undefined;
        const title = target.kind === "variant" ? meta!.name : `Tailored resume for ${job ? `${job.job.title} at ${job.company.name}` : target.id}`;
        return { kind: "resume", title, also: "", note: "", blocked: target.kind === "job" && on(target.company_slug, target.id) ? "Claude is writing this resume. Wait for it to finish, or cancel it in Activity." : null, take: () => {
          const text = this.f.texts[rel];
          const doc = this.resumeDocs.get(this.resumeKey(target, "resume.md"));
          if (target.kind === "variant") this.variantMeta.delete(target.variant);
          delete this.f.texts[rel];
          this.resumeDocs.delete(this.resumeKey(target, "resume.md"));
          return {
            restore: () => {
              if (target.kind === "variant") this.variantMeta.set(target.variant, meta!);
              if (text !== undefined) this.f.texts[rel] = text;
              if (doc) this.resumeDocs.set(this.resumeKey(target, "resume.md"), doc);
            },
            taken: () => (target.kind === "variant" ? this.variantMeta.has(target.variant) : Object.hasOwn(this.f.texts, rel)),
          };
        } };
      }
      case "topic": {
        const topic = this.learnData().topics.find((x) => x.slug === t.topic);
        if (!topic) throw new Error("That topic isn't in Learn any more.");
        const prefix = `learning/${t.topic}/`;
        const videos = this.videoMock.items().filter((v) => v.folder.startsWith(prefix)).length;
        const blocked = runs.some((r) => (r.target as { topic?: string }).topic === t.topic) ? "Claude is writing for this topic. Wait for it to finish, or cancel it in Activity."
          : this.videoMock.busyUnder(`learning/${t.topic}`) ? "A video for this topic is being made. Wait for it to finish, or cancel it." : null;
        return { kind: "topic", title: topic.title, also: videos ? `its ${plural(videos, "video")}` : "", note: "", blocked, take: () => {
          const fixed = this.f.learning.topics.find((x) => x.slug === t.topic);
          const outputs = [...this.actionOutputs].filter(([k]) => k.startsWith(prefix));
          const vids = this.videoMock.items().filter((v) => v.folder.startsWith(prefix)).map((v) => this.videoMock.take(v.folder));
          this.f.learning.topics = this.f.learning.topics.filter((x) => x !== fixed);
          for (const [k] of outputs) this.actionOutputs.delete(k);
          return {
            restore: () => { if (fixed) this.f.learning.topics.push(fixed); for (const [k, v] of outputs) this.actionOutputs.set(k, v); for (const v of vids) v.restore(); },
            taken: () => this.learnData().topics.some((x) => x.slug === t.topic),
          };
        } };
      }
      case "video": {
        const v = this.videoMock.items().find((x) => x.folder === t.folder);
        if (!v) throw new Error("There is no video in that folder.");
        return { kind: "video", title: v.title || v.type_label || "Video", also: "", note: "", blocked: this.videoMock.busyUnder(t.folder) ? "This video is busy. Cancel it first." : null, take: () => this.videoMock.take(t.folder) };
      }
    }
  }
  private trashMove(targets: TrashTarget[]): TrashItem[] {
    const plans = targets.map((t) => this.trashPlan(t));
    const stop = plans.find((p) => p.blocked);
    if (stop) throw new Error(plans.length > 1 ? `"${stop.title}" can't be deleted right now: ${stop.blocked} Nothing was deleted.` : stop.blocked!);
    const out = plans.map((p) => {
      const deleted_at = this.iso();
      const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
      const item: TrashItem = {
        id: `${deleted_at.replace(/[:.]/g, "-")}-${p.kind.replace(/_/g, "-")}-${slug}${++this.trashSeq > 1 ? `-${this.trashSeq}` : ""}`,
        kind: p.kind, title: p.title, also: p.also, deleted_at, purge_at: new Date(Date.parse(deleted_at) + 30 * 86_400_000).toISOString(),
      };
      this.binned.unshift({ item, ...p.take() });
      return item;
    });
    this.emit("jobs", "home", "learn", "video", "mail", "sponsors", "trash");
    return out;
  }
  trash = {
    check: (t: TrashTarget) => this.rec("trash.check", [t], (): TrashCheck => { const p = this.trashPlan(t); return { title: p.title, also: p.also, note: p.note, blocked: p.blocked }; }),
    move: (targets: TrashTarget[]) => this.rec("trash.move", [targets], () => this.trashMove(targets)),
    list: () => this.rec("trash.list", [], () => this.binned.map((e) => e.item)),
    restore: (id: string) => this.rec("trash.restore", [id], () => {
      const e = this.binned.find((x) => x.item.id === id);
      if (!e) throw new Error("That item isn't in Recently deleted any more.");
      if (e.taken()) throw new Error(`Something new is at its old place now, so "${e.item.title}" wasn't put back. Rename or delete that first.`);
      if (e.companyGone?.()) throw new Error(`The company it belonged to was deleted. Restore the company first, then "${e.item.title}".`);
      e.restore();
      this.binned = this.binned.filter((x) => x !== e);
      this.emit("jobs", "home", "learn", "video", "mail", "sponsors", "trash");
      return e.item;
    }),
    forget: (id: string, confirmed: boolean) => this.rec("trash.forget", [id, confirmed], () => {
      if (!confirmed) throw new Error("Confirm first: this can't be undone.");
      if (!this.binned.some((x) => x.item.id === id)) throw new Error("That item isn't in Recently deleted any more.");
      this.binned = this.binned.filter((x) => x.item.id !== id);
      this.emit("trash");
    }),
  };
  /** Preview and tests: an entry deleted `days` ago. */
  seedTrash(item: Omit<TrashItem, "purge_at" | "id"> & { id?: string }): void {
    const id = item.id ?? `${item.deleted_at.replace(/[:.]/g, "-")}-${item.kind.replace(/_/g, "-")}-seeded-${++this.trashSeq}`;
    this.binned.push({ item: { ...item, id, purge_at: new Date(Date.parse(item.deleted_at) + 30 * 86_400_000).toISOString() }, restore: () => undefined, taken: () => false });
  }

  onChange = (cb: (e: ChangeEvent) => void): (() => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  pathForFile = (file: DroppedFile): string | null => `${DOWNLOADS}/${file.name}`;
  fileUrl = (rel: string): string => demoFileUrl(rel) ?? `careeros-file://ws/${rel.split("/").map(encodeURIComponent).join("/")}`;
  mailUrl = (ref: string): string => mailUrlFor(ref);
}

/** The dev preview's bridge: Alex's tailored resume is seeded so the Resume Studio has something to show. */
export function createMockBridge(opts: MockOptions = {}): MockBridge {
  // The preview plays Claude runs through on timers; tests drive them by hand.
  const engine = { autoRun: true, ...opts.claudeEngine };
  // Preview-only: `?demo=tables` adds fictional sponsor-cache and search-log rows (see demo-tables.ts).
  if (!opts.fixture && typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "tables") {
    return new MockBridge({ now: new Date("2026-10-10T05:00:00.000Z"), resumeDemo: true, viewerDemo: true, ...opts, fixture: withTableDemo(loadFixture()), claudeEngine: engine });
  }
  // Preview-only: `?rows=N` adds N fictional companies, jobs and searches for checking long lists (see demo-rows.ts).
  const many = typeof location !== "undefined" ? new URLSearchParams(location.search).get("rows") : null;
  const b = many && /^\d{1,4}$/.test(many)
    ? new MockBridge({ resumeDemo: true, viewerDemo: true, ...opts, fixture: withManyRows(opts.fixture ?? loadFixture(), Number(many)), claudeEngine: engine })
    : new MockBridge({ resumeDemo: true, viewerDemo: true, ...opts, claudeEngine: engine });
  // Preview-only: `?resumes=N` gives the first N jobs a tailored resume and adds general versions with long names (Resumes screen).
  const resumes = typeof location !== "undefined" ? new URLSearchParams(location.search).get("resumes") : null;
  if (resumes && /^\d{1,3}$/.test(resumes)) b.seedResumeDemo(Number(resumes));
  return b;
}
