import type { ActionId, ActionPrepared, ActionStatusView, ActionTarget } from "./actions.js";
import type { ClaudeEngineState, ClaudeRunRequest, ClaudeRunView } from "./claude-engine.js";
import type { BoardId, ChromeRunProgress, ChromeSearchState } from "./chrome.js";
import type { ComposeView, OptionValue } from "./request.js";
import type { CompanyDetail, CompanyRow } from "./companies.js";
import type { AgencyPatch, AgencyRow } from "./recruiters.js";
import type { NetworkPerson, NetworkStatus } from "./network.js";
import type { JobStatus, JobSubdir, LockableDir, SecretName, SettingsKind } from "./constants.js";
import type { ExportFormat, ExportSource, ExportState } from "./exports.js";
import type { FilePreview } from "./file-preview.js";
import type { SetupToolId, SetupView } from "./setup.js";
import type { ScheduleView, SearchSchedule } from "./schedule.js";
import type { JobAddStatus, JobAdded, JobDraft, JobPreviewResult } from "./job-link.js";
import type { GuideState, LearnHub, LearnProgress, SetupStepId } from "./learn.js";
import type {
  BackgroundStatus, DraftAssist, DraftDetail, DraftInput, DraftView, MailList, MailMessageView, MailQuery, MailStatus, MailTarget, MailTestResult, PruneResult, RecheckPreview, RecheckResult, TriageItem,
} from "./mail.js";
import type { MethodName } from "./methods.js";
import type { CalendarKind } from "./ics.js";
import type { OfferDetails } from "./offers.js";
import type { TourId, TourMark, TourState } from "./tour.js";
import type { UpdateView } from "./updates.js";
import type { TrashCheck, TrashItem, TrashTarget } from "./trash.js";
import type { TtsActivity, TtsLang, TtsOptions, TtsPreviews, TtsSpeakResult, TtsStatus, TtsVoice } from "./tts.js";
import type { DownloadResult, ResumeCopy, ResumeDownload, ResumeItemRef, ResumeLibrary, ResumeRef, ResumeState, SuggestionDecision } from "./resume.js";
import type { ResumeStyle } from "./resume-style.js";
import type { ResumeFieldKey, ResumeFillState, ResumeRead, ResumeValues, TargetSuggestions } from "./resume-fields.js";
import type {
  AppInfo, ApplyState, ApprovalView, ChangeEvent, DroppedFile, FolderSuggestion, HomeSummary, InboxAddedJob, InboxItem, InboxOverview, InboxPutBack, InboxTarget, JobDetail, JobList, JobQuery,
  LearnData, LegacyPreview, LocateResult, PrivacyState, RecentWorkspace, SavedView, SearchList, SecretStatus, SettingsChange, SettingsData, SponsorRow, WorkspaceSummary,
} from "./types.js";
import type {
  INSTALLABLE_TOOLS, VideoDraftView, VideoIntent, VideoListFilter, VideoListItem, VideoOptionsArg, VideoRunView, VideoScreen,
  VideoScriptEdits, VideoSourcesView, VideoSubjectArg, VideoToolsView, VideoTypesView,
} from "./video.js";

export interface CareerosBridge {
  app: {
    info(): Promise<AppInfo>;
    /** In-app updates from GitHub Releases. Main pushes the "updates" change area as the status moves. */
    updates: {
      state(): Promise<UpdateView>;
      /** Checks now (and downloads in the background if there is one). Resolves with the status after the check. */
      check(): Promise<UpdateView>;
      /** Quits and installs the downloaded update, then opens the app again. Refused unless an update is ready. */
      install(): Promise<void>;
      /** Turns automatic checks on or off (saved for this computer). */
      setAuto(on: boolean): Promise<UpdateView>;
    };
  };
  workspace: {
    current(): Promise<WorkspaceSummary | null>;
    pickFolder(purpose: "create" | "open" | "legacy"): Promise<string | null>;
    /** Where a new CareerOS folder goes by default (no folder picker), or the one already there. */
    suggest(): Promise<FolderSuggestion>;
    /**
     * "Get started" in one click: main picks the folder (the same one `suggest` shows), then opens the workspace
     * already there or makes a new one with no name yet. The renderer never sends a path for this.
     */
    start(): Promise<WorkspaceSummary>;
    /** Name may be "": onboarding asks for it after the folder exists. */
    create(dir: string, name: string): Promise<WorkspaceSummary>;
    /**
     * Copies the bundled example (fictional data) into a fresh "CareerOS Example" folder in the home folder and
     * opens it (`isSample: true`). Calling it again resets the example. Main picks the folder; it never touches
     * any other folder, and refuses if a folder it didn't make has that name.
     */
    openSample(): Promise<WorkspaceSummary>;
    open(dir: string): Promise<WorkspaceSummary>;
    /** The workspace switcher's list: the open workspace and the others used on this computer (at most 10). */
    recent(): Promise<RecentWorkspace[]>;
    /** Opens a workspace from the list by its key. Closes the open one first (its Claude runs stop). */
    switchTo(key: string): Promise<WorkspaceSummary>;
    /** Takes a workspace off the list. Never deletes or changes any files. The open workspace can't be removed. */
    forget(key: string): Promise<RecentWorkspace[]>;
    /** Moves an empty workspace that isn't open to the system Trash and takes it off the list. Refused for anything else. */
    trash(key: string): Promise<RecentWorkspace[]>;
    /** A missing entry's folder was moved: `dir` replaces it if it is the same workspace, else nothing changes (relinked false). */
    locate(key: string, dir: string): Promise<LocateResult>;
    /** Adds a workspace folder to the list without opening it. */
    addRecent(dir: string): Promise<RecentWorkspace[]>;
    /**
     * "Start a new one" from the switcher: main makes a new folder in the home folder ("CareerOS <name>", or the
     * next free numbered one) and opens it. The renderer sends only the name ("" allowed), never a path.
     */
    startNew(name: string): Promise<WorkspaceSummary>;
    previewLegacy(src: string, dest: string): Promise<LegacyPreview>;
    importLegacy(src: string, dest: string): Promise<LegacyPreview>;
    close(): Promise<void>;
  };
  home: { summary(): Promise<HomeSummary> };
  jobs: {
    list(q: JobQuery): Promise<JobList>;
    get(slug: string, id: string): Promise<JobDetail>;
    setStatus(slug: string, id: string, status: JobStatus, note: string): Promise<JobDetail>;
    addNote(slug: string, id: string, note: string): Promise<JobDetail>;
    attach(slug: string, id: string, src: string, label: string, subdir: JobSubdir): Promise<JobDetail>;
    views(): Promise<SavedView[]>;
    saveView(name: string, query: JobQuery): Promise<SavedView[]>;
    deleteView(name: string): Promise<SavedView[]>;
    /** Sets the interview's local date and time ("2026-10-21T14:30"), or clears it with "". */
    setInterview(slug: string, id: string, at: string): Promise<JobDetail>;
    /** "Add to Calendar": writes the interview or follow-up as an .ics file in the job folder and opens it with the computer's calendar. */
    addToCalendar(slug: string, id: string, kind: CalendarKind): Promise<void>;
    /** Saves what an offer is worth (base, super rate, bonus and notes) on the job, for Compare offers. */
    setOffer(slug: string, id: string, offer: OfferDetails): Promise<JobDetail>;
    /**
     * "Add a job": reads a pasted link (an applicant system's public data, or a job board in the person's own Chrome
     * when it's connected) or uses pasted text, and returns a preview to check. Nothing is saved.
     */
    preview(input: { url?: string; text?: string }): Promise<JobPreviewResult>;
    /** The same for a dropped or picked file (its text is read on this computer). Nothing is copied or saved. */
    previewFile(path: string): Promise<JobPreviewResult>;
    /** Saves the checked preview as a job. A duplicate isn't saved twice: the existing job comes back with created false. */
    add(draft: JobDraft, status: JobAddStatus): Promise<JobAdded>;
  };
  apply: {
    state(slug: string, id: string): Promise<ApplyState>;
    prepare(slug: string, id: string): Promise<ApplyState>;
    requestApproval(slug: string, id: string): Promise<ApplyState>;
    markApplied(slug: string, id: string): Promise<ApplyState>;
  };
  inbox: {
    list(): Promise<InboxItem[]>; add(paths: string[]): Promise<InboxItem[]>; file(name: string, target: InboxTarget, note: string): Promise<InboxItem[]>; overview(): Promise<InboxOverview>;
    /** Moves these drop box files to the Trash (recoverable). */
    remove(names: string[]): Promise<InboxItem[]>;
    /** Returns a file to the folder it was added from (only when `from` is set). */
    putBack(name: string): Promise<InboxPutBack>;
    /** Asks Claude where this one file belongs. Returns at once; the item shows a running chip until it's done. */
    ask(name: string): Promise<InboxItem[]>;
    /** Saves a job ad as a new job (its text becomes the job's ad), then files the original into that job. */
    addAsJob(name: string, job: { company: string; title: string }): Promise<InboxAddedJob>;
    /** Fill from my resume, on this waiting file: read it on this computer (fields only). Refused for a locked-folder file. */
    readResume(name: string): Promise<ResumeRead>;
    /** Fill from my resume, on this waiting file: save the reviewed values and keep a copy in Resumes. The file stays waiting. */
    fillProfile(name: string, values: ResumeValues, overwrite: ResumeFieldKey[]): Promise<ResumeFillState>;
  };
  learn: {
    list(): Promise<LearnData>;
    /** Everything Learn shows: items with progress, suggested topics from saved jobs, jobs to score. */
    hub(): Promise<LearnHub>;
    /** Records progress on one listed guide, video or prep item. */
    setProgress(rel: string, progress: LearnProgress): Promise<LearnHub>;
  };
  /** The first-run checklists ("Set up JobCairn", then "Getting started"). `setSkipped`: skip or un-skip an optional setup step. */
  guide: { state(): Promise<GuideState>; setDismissed(dismissed: boolean): Promise<GuideState>; setSkipped(id: SetupStepId, skipped: boolean): Promise<GuideState> };
  /** Guided tours: which were seen or skipped in this folder, "Replay all tours" and "Turn off tour tips". */
  tour: { state(): Promise<TourState>; mark(id: TourId, mark: TourMark): Promise<TourState>; replayAll(): Promise<TourState>; setOff(off: boolean): Promise<TourState> };
  /** "Fill from my resume". */
  profile: {
    /** Reads a dropped or picked resume (PDF, Word, Markdown or text, at most 10 MB) on this computer. Nothing is saved. */
    readResume(path: string): Promise<ResumeRead>;
    /**
     * Copies the resume into me/resumes and saves the reviewed values. A field that already has a value is changed
     * only when it is listed in `overwrite`.
     */
    fillFromResume(path: string, values: ResumeValues, overwrite: ResumeFieldKey[]): Promise<ResumeFillState>;
    fillState(): Promise<ResumeFillState | null>;
    markFillSeen(): Promise<ResumeFillState | null>;
    /** Claude's latest suggested roles and skills (suggest_targets), or null. */
    suggestions(): Promise<TargetSuggestions | null>;
  };
  files: {
    readText(rel: string): Promise<string>; reveal(rel: string): Promise<void>; pick(): Promise<string | null>;
    /** The in-app viewer's answer for one workspace file (text, a media flag, or why it can't be shown). Never reads a locked folder. */
    preview(rel: string): Promise<FilePreview>;
    /** Opens a document or media file in its default app. Apps and scripts are refused, and so are locked folders. */
    open(rel: string): Promise<void>;
  };
  sponsors: { list(): Promise<SponsorRow[]> };
  /** Every company in the workspace, and one company's page. `key` is a row's `key` (its folder slug, or a list-only employer's name slug). */
  companies: { list(): Promise<CompanyRow[]>; get(key: string): Promise<CompanyDetail> };
  /** Recruitment agencies (recruiters/<slug>/agency.json) as cards, and the person's own changes to one: favourite and tracking. */
  recruiters: {
    list(): Promise<AgencyRow[]>; update(slug: string, patch: AgencyPatch): Promise<AgencyRow>;
    /** Copies one of your resumes (me/resumes/<file>) for an email: into a job's application folder, or (id "") the company's emails/outgoing. */
    attachResume(slug: string, id: string, rel: string): Promise<{ rel: string }>;
    /** Makes sure the agency has a company folder (same slug) so a general enquiry can be drafted and filed there. */
    mailbox(slug: string): Promise<{ company_slug: string }>;
  };
  /**
   * The person's own LinkedIn connections (Connections.csv from LinkedIn's data export), kept on this computer.
   * `importLinkedIn` takes the picked file's path and replaces the saved list; `people` matches a company name.
   */
  network: {
    status(): Promise<NetworkStatus>; importLinkedIn(path: string): Promise<NetworkStatus>;
    people(company: string): Promise<NetworkPerson[]>; forget(): Promise<NetworkStatus>;
  };
  searches: { list(): Promise<SearchList> };
  settings: { get(kind: SettingsKind): Promise<SettingsData>; save(kind: SettingsKind, changes: SettingsChange[]): Promise<SettingsData> };
  privacy: {
    get(): Promise<PrivacyState>;
    setLocked(folder: LockableDir, locked: boolean): Promise<PrivacyState>;
    allow(requestId: string, minutes: number): Promise<PrivacyState>;
    deny(requestId: string): Promise<PrivacyState>;
    revoke(folder: LockableDir): Promise<PrivacyState>;
    /** After a locked folder was moved or replaced: lock the folders where they are now (creating a missing one). */
    acceptFolders(): Promise<PrivacyState>;
    /** Moves a locked folder from where it was found back to its expected path (only into an absent or empty folder). */
    moveBack(folder: LockableDir): Promise<PrivacyState>;
  };
  approvals: {
    list(): Promise<ApprovalView[]>;
    /** `digest` is the one shown with the card: the services refuse when the record on disk no longer matches it. */
    approve(id: string, digest: string): Promise<ApprovalView>;
    decline(id: string, note: string): Promise<ApprovalView>;
  };
  secrets: { status(name: SecretName): Promise<SecretStatus>; set(name: SecretName, value: string): Promise<SecretStatus>; remove(name: SecretName): Promise<SecretStatus> };
  links: { open(url: string): Promise<boolean> };
  claude: {
    openDesktop(): Promise<boolean>;
    /** Where an action stands: idle, pending (asked in the last day), ready (its files exist) or blocked (a prerequisite is missing). */
    status(action: ActionId, target: ActionTarget): Promise<ActionStatusView>;
    /** Writes the hand-off note, copies the prompt and, if `open`, opens Claude Desktop. Nothing is run. */
    prepare(action: ActionId, target: ActionTarget, open: boolean): Promise<ActionPrepared>;
    /** Claude Code engine: CLI, sign-in, bundled plugin, consent and this month's cost. `recheck` skips the 30 s cache. */
    engine(recheck: boolean): Promise<ClaudeEngineState>;
    /** Records "I understand" for the current notice in workspace settings. */
    consent(): Promise<ClaudeEngineState>;
    /** Turns Claude Code's auto mode on or off for this workspace (rewrites its .claude/settings.json). */
    setAutoMode(on: boolean): Promise<ClaudeEngineState>;
    /** Runs the workspace's Claude setup again: settings, CLAUDE.md rules, the browser command, the version stamp. */
    repair(): Promise<ClaudeEngineState>;
    /** Opens a terminal running `claude` so the person signs in there. The app never sees the login. */
    openSignIn(): Promise<boolean>;
    /** A tiny run with no tools, in an empty temporary folder, to prove the setup works. */
    testRun(): Promise<ClaudeRunView>;
    /** Starts the action (or returns the run already active for this action and target). */
    run(action: ActionId, target: ActionTarget, request: ClaudeRunRequest): Promise<ClaudeRunView>;
    /** Active runs first, then recent ones (at most 50). */
    runs(): Promise<ClaudeRunView[]>;
    cancel(runId: string): Promise<ClaudeRunView>;
    /** What the request composer needs: title and company, the last-used options (or the defaults) and skill chips. */
    compose(action: ActionId, target: ActionTarget): Promise<ComposeView>;
    /** Remembers the options for this action and target. They are checked against the action's allowlist. */
    saveOptions(action: ActionId, target: ActionTarget, options: Record<string, OptionValue>): Promise<ComposeView>;
  };
  mail: {
    status(): Promise<MailStatus>;
    /** The only call that carries the app password. It is tested in the main process and never returned. */
    testConnection(address: string, displayName: string, password: string): Promise<MailTestResult>;
    saveAccount(address: string, displayName: string): Promise<MailStatus>;
    disconnect(): Promise<MailStatus>;
    setSignature(text: string): Promise<MailStatus>;
    syncNow(): Promise<MailStatus>;
    list(q: MailQuery): Promise<MailList>;
    get(ref: string): Promise<MailMessageView>;
    loadImages(ref: string): Promise<MailMessageView>;
    saveAttachment(ref: string, part: string): Promise<MailMessageView>;
    move(ref: string, target: MailTarget): Promise<MailMessageView>;
    prune(months: number): Promise<PruneResult>;
    /** "Re-check filed mail" with today's matching rules: preview, apply exactly that preview, or mark the automatic offer as seen. */
    recheck: { preview(): Promise<RecheckPreview>; apply(token: string): Promise<RecheckResult>; dismiss(): Promise<void> };
    triage: {
      list(): Promise<TriageItem[]>;
      assign(id: string, target: MailTarget, addMatch: boolean): Promise<TriageItem[]>;
      createCompany(id: string, name: string, jobTitle: string): Promise<TriageItem[]>;
      ignore(id: string, scope: "sender" | "domain"): Promise<TriageItem[]>;
    };
    drafts: {
      all(): Promise<DraftView[]>;
      list(slug: string, id: string): Promise<DraftView[]>;
      get(slug: string, id: string, draftId: string): Promise<DraftDetail>;
      /** draftId "" creates a new draft. */
      save(slug: string, id: string, draftId: string, draft: DraftInput): Promise<DraftDetail>;
      propose(slug: string, id: string, draftId: string): Promise<ApprovalView>;
      /** Claude's latest suggested email for this job (draft_email) and who it could go to, for the composer. */
      assist(slug: string, id: string): Promise<DraftAssist>;
    };
    /** For an approved email send whose outcome is unknown (`ApprovalView.unsure`). */
    send: {
      /** Sends nothing: records the email as sent and closes the approval. */
      markSent(approvalId: string): Promise<ApprovalView>;
      /**
       * Sends the same message once more. `digest` is the approval's digest as the confirm dialog showed it; it must
       * also match the one recorded when the person approved it. `confirm` must be true (the UI asks first): the
       * person may get it twice.
       */
      again(approvalId: string, digest: string, confirm: boolean): Promise<ApprovalView>;
    };
    background: { status(): Promise<BackgroundStatus>; set(on: boolean, minutes: number): Promise<BackgroundStatus> };
  };
  /**
   * Search in my Chrome (lane S). Optional so previews and older shells without it still build; the UI then
   * says the feature isn't available here.
   */
  chrome?: {
    state(recheck: boolean): Promise<ChromeSearchState>;
    /** Installs the browser helper (after a confirm in main). One install at a time. */
    install(): Promise<ChromeSearchState>;
    /** Opens Chrome's remote-control page so the person can switch it on. */
    openRemote(): Promise<ChromeSearchState>;
    /** Makes the app's one connection to Chrome (Chrome asks once). */
    connect(): Promise<ChromeSearchState>;
    /** Brings that board's tab to the front so the person can sign in. */
    showBoard(board: BoardId): Promise<ChromeSearchState>;
    /**
     * Opens the board's home page in the chosen Chrome profile with Chrome's own program, never the remote control
     * (for a board a run stopped, so the person can finish a security check). Optional for older shells.
     */
    openHome?(board: BoardId): Promise<void>;
    /** The person says they're signed in to a board the check couldn't read. Remembered with the date. */
    confirmSignIn(board: BoardId): Promise<ChromeSearchState>;
    /** The Chrome profile folder to open the app's tabs in (one of `state.profiles`), or "" for the window used last. */
    setProfile(dir: string): Promise<ChromeSearchState>;
    /** Deletes the app's own copy of the browser helper (after a confirm in main). Turns Search in my Chrome off. */
    removeHelper(): Promise<ChromeSearchState>;
    finish(boards: BoardId[]): Promise<ChromeSearchState>;
    setBoards(boards: BoardId[]): Promise<ChromeSearchState>;
    turnOff(): Promise<ChromeSearchState>;
    /** The boards for the next find-jobs run only (the composer's chips). */
    runBoards(boards: BoardId[]): Promise<void>;
    /** Per-board progress of the find-jobs run using Chrome, or null when none is running. */
    progress(): Promise<ChromeRunProgress | null>;
    /** Answers a paused board: carry on after the person finished the check, or skip it for this run. */
    answer(board: BoardId, answer: "continue" | "skip"): Promise<ChromeRunProgress | null>;
  };
  /** Find jobs' "Repeat this search": the saved schedule, its next run, and "Open JobCairn at login". */
  schedule: {
    get(): Promise<ScheduleView>;
    /** Saves the schedule (counting starts again from now); `openAtLogin` turns opening at login on or off. */
    save(schedule: SearchSchedule, openAtLogin?: boolean): Promise<ScheduleView>;
  };
  docs: {
    state(slug: string, id: string): Promise<ExportState>;
    /** Writes application/export/<source>.<format>. Refuses to replace existing files unless `overwrite`. */
    export(slug: string, id: string, sources: ExportSource[], formats: ExportFormat[], overwrite: boolean): Promise<ExportState>;
  };
  tts: {
    /** Which voice engine reading aloud will use right now, in plain words. */
    status(): Promise<TtsStatus>;
    /** Speaks one paragraph on this computer and returns a careeros-file: URL for the audio. `source` is the file it came from, or "". */
    speak(text: string, options: TtsOptions, source: string, requestId: string): Promise<TtsSpeakResult>;
    /** Stops a speak call that is still running. Resolves true if one was stopped. */
    cancel(requestId: string): Promise<boolean>;
    previews(): Promise<TtsPreviews>;
    /** Samples for the default voice and the chosen read-aloud voice (not all ten), in the background. */
    generatePreviews(lang: TtsLang): Promise<TtsPreviews>;
    /** Makes one voice's sample (if it isn't saved yet) and resolves when it is ready. Read aloud always goes first. */
    previewVoice(voice: TtsVoice, lang: TtsLang): Promise<TtsPreviews>;
    /** What the voice is doing right now, to explain a wait. */
    activity(): Promise<TtsActivity>;
    /** Deletes the saved read-aloud audio. Returns the number of files removed. */
    clearCache(): Promise<number>;
    /** Downloads the Supertonic voice model. The only read-aloud call that uses the network; only from a click in Settings. */
    downloadVoice(): Promise<TtsStatus>;
    /**
     * Installs the Supertonic package itself into the app's own Python environment (not the model: that stays
     * `downloadVoice`). Only from an explicit click in Settings > Voice, after the person confirms.
     */
    installVoice(): Promise<TtsStatus>;
    /** Stops a running voice install, download or preview generation. Resolves true if something was stopped. */
    stopVoiceWork(): Promise<boolean>;
  };
  /** The tools the app can install for the person (Claude Code, Node.js, Python, ffmpeg), one at a time, each after a yes. */
  setup: {
    /** What is on this computer, and the install running now. `refresh` looks again instead of using the last check. */
    status(refresh?: boolean): Promise<SetupView>;
    /**
     * Installs one tool after a native confirm that names the exact command. Resolves with the new status once the
     * tool checks out; rejects with a plain sentence otherwise (cancelled, no Homebrew, failed, still unusable).
     */
    install(id: SetupToolId): Promise<SetupView>;
    /** Stops the running install. True if one was running. */
    cancel(): Promise<boolean>;
  };
  resume: {
    load(ref: ResumeRef, file: string): Promise<ResumeState>;
    /**
     * Autosave. `digest` is the one the editor loaded: refused if the file changed since. `replacing`: the person
     * keeps their edits over an outside change, which is kept as a "replaced" version first.
     */
    save(ref: ResumeRef, file: string, markdown: string, style: ResumeStyle, digest: string, replacing: boolean): Promise<ResumeState>;
    /** The Markdown of one saved version, for a diff. */
    version(ref: ResumeRef, file: string, versionId: string): Promise<string>;
    restore(ref: ResumeRef, file: string, versionId: string, digest: string): Promise<ResumeState>;
    /**
     * Claude's suggested rewrite (asked for with claude.run("rewrite_resume", …)): accept it as the resume, reject
     * it, or keep my edits (the suggestion is saved under Versions first). `digest` as for save. Jobs only.
     */
    suggestion(ref: ResumeRef, file: string, decision: SuggestionDecision, digest: string): Promise<ResumeState>;
    /** Shows a save dialog in the main process and writes the file there. */
    download(ref: ResumeRef, file: string, format: ResumeDownload): Promise<DownloadResult>;
    copy(ref: ResumeRef, file: string, format: ResumeCopy): Promise<boolean>;
  };
  /** The Resumes screen. */
  resumes: {
    list(): Promise<ResumeLibrary>;
    /** Makes a general version's folder (no resume yet; Claude writes it with tailor_resume_variant) and returns its slug. */
    newVariant(name: string): Promise<{ variant: string }>;
    /** A copy of a resume (and its style) as a new general version, ready to edit. */
    duplicate(source: ResumeItemRef, name: string): Promise<{ variant: string }>;
    /** Moves a resume to the Trash. True when it was moved. */
    /** Moves a resume to Recently deleted (the workspace trash). The entry comes back for Undo. */
    remove(target: ResumeItemRef): Promise<TrashItem>;
  };
  /** Delete with Undo: items move to the workspace trash and stay in Recently deleted for 30 days. */
  trash: {
    /** The name and what goes with it, for the confirm dialog, and why it can't be deleted now (if so). */
    check(target: TrashTarget): Promise<TrashCheck>;
    /** Moves every target to the trash, one entry each. Every target is checked first: one refusal moves nothing. */
    move(targets: TrashTarget[]): Promise<TrashItem[]>;
    list(): Promise<TrashItem[]>;
    /** Puts an entry back where it was. Refuses when something new is at that place, or its company is gone. */
    restore(id: string): Promise<TrashItem>;
    /** Deletes an entry for good. `confirmed` must be true. */
    forget(id: string, confirmed: boolean): Promise<void>;
  };
  video: {
    types(screen: VideoScreen): Promise<VideoTypesView>;
    tools(refresh: boolean): Promise<VideoToolsView>;
    sources(type: string, subject: VideoSubjectArg): Promise<VideoSourcesView>;
    start(type: string, subject: VideoSubjectArg, options: VideoOptionsArg): Promise<VideoRunView>;
    run(runId: string): Promise<VideoRunView | null>;
    runs(): Promise<VideoRunView[]>;
    cancel(runId: string): Promise<boolean>;
    draft(folder: string): Promise<VideoDraftView>;
    saveScript(folder: string, edits: VideoScriptEdits): Promise<VideoDraftView>;
    revise(folder: string, note: string): Promise<VideoRunView>;
    approveScript(folder: string): Promise<VideoRunView>;
    render(folder: string, quality: "draft" | "final"): Promise<VideoRunView>;
    /** Try again after making the video stopped: the same render, from the stage that failed. `skip_check`: without the layout check. */
    retry(folder: string, opts: { skip_check?: boolean }): Promise<VideoRunView>;
    list(filter: VideoListFilter): Promise<VideoListItem[]>;
    /** Moves a video to Recently deleted (the workspace trash). The entry comes back for Undo. */
    delete(folder: string): Promise<TrashItem>;
    exportCaptions(folder: string, format: "srt" | "vtt"): Promise<string>;
    installTool(id: (typeof INSTALLABLE_TOOLS)[number]): Promise<VideoToolsView>;
    takeIntent(): Promise<VideoIntent | null>;
  };
  /** Local (not a call): subscribe to "something changed" pushes. Returns an unsubscribe function. */
  onChange(cb: (e: ChangeEvent) => void): () => void;
  /** Local: the real path of a dropped file, or null when the shell can't tell. */
  pathForFile(file: DroppedFile): string | null;
  /** Local: a careeros-file: URL for showing a workspace file (video, image, PDF). */
  fileUrl(rel: string): string;
  /** Local: the careeros-mail: URL of a stored message's sanitized body, for a sandboxed frame. */
  mailUrl(ref: string): string;
}

export interface Transport {
  call(method: MethodName, args: unknown[]): Promise<unknown>;
  onChange(cb: (e: ChangeEvent) => void): () => void;
  pathForFile(file: DroppedFile): string | null;
  fileUrl(rel: string): string;
  mailUrl(ref: string): string;
}

export function createRemoteBridge(t: Transport): CareerosBridge {
  // The transport returns unknown; each method's declared return type is the contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (m: MethodName, ...args: unknown[]): Promise<any> => t.call(m, args);
  return {
    app: {
      info: () => c("app.info"),
      updates: { state: () => c("app.updates.state"), check: () => c("app.updates.check"), install: () => c("app.updates.install"), setAuto: (on) => c("app.updates.setAuto", on) },
    },
    workspace: {
      current: () => c("workspace.current"), pickFolder: (p) => c("workspace.pickFolder", p),
      suggest: () => c("workspace.suggest"), start: () => c("workspace.start"), openSample: () => c("workspace.openSample"),
      create: (dir, name) => c("workspace.create", dir, name), open: (dir) => c("workspace.open", dir),
      previewLegacy: (src, dest) => c("workspace.previewLegacy", src, dest), importLegacy: (src, dest) => c("workspace.importLegacy", src, dest),
      close: () => c("workspace.close"),
      recent: () => c("workspace.recent"), switchTo: (k) => c("workspace.switchTo", k), forget: (k) => c("workspace.forget", k),
      trash: (k) => c("workspace.trash", k), locate: (k, d) => c("workspace.locate", k, d), addRecent: (d) => c("workspace.addRecent", d),
      startNew: (n) => c("workspace.startNew", n),
    },
    home: { summary: () => c("home.summary") },
    jobs: {
      list: (q) => c("jobs.list", q), get: (s, i) => c("jobs.get", s, i), setStatus: (s, i, st, n) => c("jobs.setStatus", s, i, st, n),
      addNote: (s, i, n) => c("jobs.addNote", s, i, n), attach: (s, i, src, l, sub) => c("jobs.attach", s, i, src, l, sub),
      views: () => c("jobs.views"), saveView: (n, q) => c("jobs.saveView", n, q), deleteView: (n) => c("jobs.deleteView", n),
      preview: (i) => c("jobs.preview", i), previewFile: (p) => c("jobs.previewFile", p), add: (d, s) => c("jobs.add", d, s),
      setInterview: (s, i, at) => c("jobs.setInterview", s, i, at), addToCalendar: (s, i, k) => c("jobs.addToCalendar", s, i, k),
      setOffer: (s, i, o) => c("jobs.setOffer", s, i, o),
    },
    apply: {
      state: (s, i) => c("apply.state", s, i), prepare: (s, i) => c("apply.prepare", s, i),
      requestApproval: (s, i) => c("apply.requestApproval", s, i), markApplied: (s, i) => c("apply.markApplied", s, i),
    },
    inbox: {
      list: () => c("inbox.list"), add: (p) => c("inbox.add", p), file: (n, tg, note) => c("inbox.file", n, tg, note), overview: () => c("inbox.overview"),
      remove: (names) => c("inbox.remove", names), putBack: (n) => c("inbox.putBack", n),
      ask: (n) => c("inbox.ask", n), addAsJob: (n, j) => c("inbox.addAsJob", n, j),
      readResume: (n) => c("inbox.readResume", n), fillProfile: (n, v, o) => c("inbox.fillProfile", n, v, o),
    },
    learn: { list: () => c("learn.list"), hub: () => c("learn.hub"), setProgress: (r, p) => c("learn.setProgress", r, p) },
    guide: { state: () => c("guide.state"), setDismissed: (d) => c("guide.setDismissed", d), setSkipped: (id, s) => c("guide.setSkipped", id, s) },
    tour: { state: () => c("tour.state"), mark: (id, m) => c("tour.mark", id, m), replayAll: () => c("tour.replayAll"), setOff: (o) => c("tour.setOff", o) },
    profile: {
      readResume: (p) => c("profile.readResume", p), fillFromResume: (p, v, o) => c("profile.fillFromResume", p, v, o),
      fillState: () => c("profile.fillState"), markFillSeen: () => c("profile.markFillSeen"), suggestions: () => c("profile.suggestions"),
    },
    files: { readText: (r) => c("files.readText", r), reveal: (r) => c("files.reveal", r), pick: () => c("files.pick"), preview: (r) => c("files.preview", r), open: (r) => c("files.open", r) },
    sponsors: { list: () => c("sponsors.list") },
    companies: { list: () => c("companies.list"), get: (k) => c("companies.get", k) },
    recruiters: { list: () => c("recruiters.list"), update: (s, p) => c("recruiters.update", s, p), attachResume: (s, i, r) => c("recruiters.attachResume", s, i, r), mailbox: (s) => c("recruiters.mailbox", s) },
    network: {
      status: () => c("network.status"), importLinkedIn: (p) => c("network.importLinkedIn", p),
      people: (co) => c("network.people", co), forget: () => c("network.forget"),
    },
    searches: { list: () => c("searches.list") },
    settings: { get: (k) => c("settings.get", k), save: (k, ch) => c("settings.save", k, ch) },
    privacy: {
      get: () => c("privacy.get"), setLocked: (f, l) => c("privacy.setLocked", f, l), allow: (id, m) => c("privacy.allow", id, m),
      deny: (id) => c("privacy.deny", id), revoke: (f) => c("privacy.revoke", f), acceptFolders: () => c("privacy.acceptFolders"), moveBack: (f) => c("privacy.moveBack", f),
    },
    approvals: { list: () => c("approvals.list"), approve: (id, d) => c("approvals.approve", id, d), decline: (id, n) => c("approvals.decline", id, n) },
    secrets: { status: (n) => c("secrets.status", n), set: (n, v) => c("secrets.set", n, v), remove: (n) => c("secrets.remove", n) },
    links: { open: (u) => c("links.open", u) },
    claude: {
      openDesktop: () => c("claude.openDesktop"), status: (a, tg) => c("claude.status", a, tg), prepare: (a, tg, o) => c("claude.prepare", a, tg, o),
      engine: (r) => c("claude.engine", r), consent: () => c("claude.consent"),
      setAutoMode: (on) => c("claude.setAutoMode", on), repair: () => c("claude.repair"),
      openSignIn: () => c("claude.openSignIn"), testRun: () => c("claude.testRun"), run: (a, tg, rq) => c("claude.run", a, tg, rq ?? {}),
      runs: () => c("claude.runs"), cancel: (id) => c("claude.cancel", id),
      compose: (a, tg) => c("claude.compose", a, tg), saveOptions: (a, tg, op) => c("claude.saveOptions", a, tg, op),
    },
    mail: {
      status: () => c("mail.status"), testConnection: (a, n, p) => c("mail.testConnection", a, n, p), saveAccount: (a, n) => c("mail.saveAccount", a, n),
      disconnect: () => c("mail.disconnect"), setSignature: (t) => c("mail.setSignature", t), syncNow: () => c("mail.syncNow"),
      list: (q) => c("mail.list", q), get: (r) => c("mail.get", r), loadImages: (r) => c("mail.loadImages", r),
      saveAttachment: (r, p) => c("mail.saveAttachment", r, p), move: (r, tg) => c("mail.move", r, tg), prune: (m) => c("mail.prune", m),
      recheck: { preview: () => c("mail.recheck.preview"), apply: (t) => c("mail.recheck.apply", t), dismiss: () => c("mail.recheck.dismiss") },
      triage: {
        list: () => c("mail.triage.list"), assign: (id, tg, add) => c("mail.triage.assign", id, tg, add),
        createCompany: (id, n, t) => c("mail.triage.createCompany", id, n, t), ignore: (id, s) => c("mail.triage.ignore", id, s),
      },
      drafts: {
        all: () => c("mail.drafts.all"), list: (s, i) => c("mail.drafts.list", s, i), get: (s, i, d) => c("mail.drafts.get", s, i, d),
        save: (s, i, d, dr) => c("mail.drafts.save", s, i, d, dr), propose: (s, i, d) => c("mail.drafts.propose", s, i, d),
        assist: (s, i) => c("mail.drafts.assist", s, i),
      },
      send: { markSent: (id) => c("mail.send.markSent", id), again: (id, digest, ok) => c("mail.send.again", id, digest, ok) },
      background: { status: () => c("mail.background.status"), set: (on, m) => c("mail.background.set", on, m) },
    },
    chrome: {
      state: (r) => c("chrome.state", r), install: () => c("chrome.install"), openRemote: () => c("chrome.openRemote"), connect: () => c("chrome.connect"),
      showBoard: (b) => c("chrome.showBoard", b), openHome: (b) => c("chrome.openHome", b), confirmSignIn: (b) => c("chrome.confirmSignIn", b), setProfile: (d) => c("chrome.setProfile", d), removeHelper: () => c("chrome.removeHelper"), finish: (b) => c("chrome.finish", b),
      setBoards: (b) => c("chrome.setBoards", b), turnOff: () => c("chrome.turnOff"), runBoards: (b) => c("chrome.runBoards", b),
      progress: () => c("chrome.progress"), answer: (b, a) => c("chrome.answer", b, a),
    },
    schedule: { get: () => c("schedule.get"), save: (s, o) => c("schedule.save", s, o) },
    docs: { state: (s, i) => c("docs.state", s, i), export: (s, i, so, f, o) => c("docs.export", s, i, so, f, o) },
    tts: {
      status: () => c("tts.status"), speak: (tx, o, src, r) => c("tts.speak", tx, o, src, r), cancel: (r) => c("tts.cancel", r),
      previews: () => c("tts.previews"), generatePreviews: (l) => c("tts.generatePreviews", l), clearCache: () => c("tts.clearCache"),
      previewVoice: (v, l) => c("tts.previewVoice", v, l), activity: () => c("tts.activity"),
      downloadVoice: () => c("tts.downloadVoice"), installVoice: () => c("tts.installVoice"), stopVoiceWork: () => c("tts.stopVoiceWork"),
    },
    setup: { status: (r) => c("setup.status", r), install: (id) => c("setup.install", id), cancel: () => c("setup.cancel") },
    resume: {
      load: (r, f) => c("resume.load", r, f), save: (r, f, md, st, d, rp) => c("resume.save", r, f, md, st, d, rp),
      version: (r, f, v) => c("resume.version", r, f, v), restore: (r, f, v, d) => c("resume.restore", r, f, v, d),
      suggestion: (r, f, dec, d) => c("resume.suggestion", r, f, dec, d),
      download: (r, f, fmt) => c("resume.download", r, f, fmt), copy: (r, f, fmt) => c("resume.copy", r, f, fmt),
    },
    resumes: { list: () => c("resumes.list"), newVariant: (n) => c("resumes.newVariant", n), duplicate: (src, n) => c("resumes.duplicate", src, n), remove: (t) => c("resumes.remove", t) },
    trash: {
      check: (t) => c("trash.check", t), move: (ts) => c("trash.move", ts), list: () => c("trash.list"),
      restore: (id) => c("trash.restore", id), forget: (id, ok) => c("trash.forget", id, ok),
    },
    video: {
      types: (s) => c("video.types", s), tools: (r) => c("video.tools", r), sources: (t, s) => c("video.sources", t, s),
      start: (t, s, o) => c("video.start", t, s, o), run: (id) => c("video.run", id), runs: () => c("video.runs"), cancel: (id) => c("video.cancel", id),
      draft: (f) => c("video.draft", f), saveScript: (f, e) => c("video.saveScript", f, e), revise: (f, n) => c("video.revise", f, n),
      approveScript: (f) => c("video.approveScript", f), render: (f, q) => c("video.render", f, q), retry: (f, o) => c("video.retry", f, o ?? {}), list: (x) => c("video.list", x),
      delete: (f) => c("video.delete", f), exportCaptions: (f, x) => c("video.exportCaptions", f, x), installTool: (id) => c("video.installTool", id),
      takeIntent: () => c("video.takeIntent"),
    },
    onChange: (cb) => t.onChange(cb),
    pathForFile: (f) => t.pathForFile(f),
    fileUrl: (r) => t.fileUrl(r),
    mailUrl: (r) => t.mailUrl(r),
  };
}
