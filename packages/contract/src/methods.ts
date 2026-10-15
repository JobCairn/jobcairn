import {
  JOB_SOURCES, JOB_STATUSES, JOB_SUBDIRS, LOCKABLE_DIRS, ME_DIRS, SECRET_NAMES, SETTINGS_KINDS, WR_LABELS,
} from "./constants.js";
import { ACTION_IDS, TARGET_KINDS, TOPIC_LABEL, type ActionTarget, type TargetKind } from "./actions.js";
import { EXPORT_FORMATS, EXPORT_SOURCES } from "./exports.js";
import { claudeRunRequest, runId } from "./claude-engine.js";
import { JOB_TYPES, SPONSOR_TIERS } from "./job-filters.js";
import { BOARD_IDS } from "./chrome.js";
import { MAX_SPEAK_CHARS, TTS_LANG_CODE, TTS_REQUEST_ID, TTS_VOICES } from "./tts.js";
import { BASE_RESUME_REL, RESUME_COPY, RESUME_DOWNLOADS, resumeFile, resumeItemRef, resumeMarkdown, resumeRef, resumeStyleArg, suggestionDecision, VARIANT_NAME, variantSlug, versionId } from "./resume.js";
import { LEARN_PROGRESS, SKIPPABLE_SETUP } from "./learn.js";
import { MAIL_REF_PATTERN } from "./mail.js";
import { TOUR_IDS, TOUR_MARKS } from "./tour.js";
import { CALENDAR_KINDS, INTERVIEW_AT } from "./ics.js";
import { OFFER_TEXT_MAX } from "./offers.js";
import type { InboxTarget } from "./types.js";
import { RESUME_FIELD_KEYS, RESUME_FIELD_MAX } from "./resume-fields.js";
import { JOB_ADD_STATUSES, jobDraftArg, jobPreviewInput } from "./job-link.js";
import {
  absPath, ArgError, arr, bool, digest, fileName, httpsUrl, int, json, num, obj, oneOf, opt, queueId, relPath, segmentName, settingsPath, slug, str, type V,
} from "./validate.js";
import { trashId, trashTarget } from "./trash.js";
import { agencyPatchArgs } from "./recruiters.js";
import { SETUP_TOOLS } from "./setup.js";
import { INSTALLABLE_TOOLS, VIDEO_SCREENS, videoFolder, videoListFilter, videoOptions, videoRunId, videoScriptEdits, videoSubject, videoTypeId } from "./video.js";

const text = (max: number) => str({ max });
const required = (max: number) => str({ min: 1, max });
// Notes are free text the user types in a textarea and may legitimately span lines;
// everything else (names, labels, search text) is a single line.
const note = (max: number) => str({ max, multiline: true });
const requiredNote = (max: number) => str({ min: 1, max, multiline: true });

export const jobQuery = obj({
  text: opt(text(200)), statuses: opt(arr(oneOf(JOB_STATUSES), { max: 8 })), showIneligible: opt(bool),
  labels: opt(arr(oneOf(WR_LABELS), { max: 5 })), location: opt(text(120)), modes: opt(arr(required(20), { max: 5 })),
  salaryMin: opt(num(0, 10_000_000)), sources: opt(arr(oneOf(JOB_SOURCES), { max: 4 })), fitMin: opt(num(0, 100)),
  sponsorMin: opt(num(0, 100)), since: opt(str({ max: 30, pattern: /^\d{4}-\d{2}-\d{2}/ })),
  sponsorTiers: opt(arr(oneOf(SPONSOR_TIERS), { max: SPONSOR_TIERS.length })), jobTypes: opt(arr(oneOf([...JOB_TYPES, ""] as const), { max: JOB_TYPES.length + 1 })),
  sites: opt(arr(required(60), { max: 20 })), postedDays: opt(int(1, 365)), postedUndated: opt(bool),
  sort: opt(oneOf(["default", "fit", "sponsor", "newest", "fresh"] as const)), limit: opt(int(1, 500)), offset: opt(int(0, 1_000_000)),
  hideStale: opt(bool),
});

/** A money figure or null (left blank). */
const money: V<number | null> = (v, at) => (v === null ? null : num(0, 100_000_000)(v, at));
/** An offer's details (offers.ts OfferDetails): every field present. */
const offerArg = obj({
  base: money, super_rate: (v: unknown, at: string) => (v === null ? null : num(0, 0.5)(v, at)), bonus: money,
  equity: str({ max: OFFER_TEXT_MAX }), work_mode: str({ max: OFFER_TEXT_MAX }), commute: str({ max: OFFER_TEXT_MAX }),
  start_date: str({ max: 10, pattern: /^(\d{4}-\d{2}-\d{2})?$/ }),
});

const meTarget = obj({ kind: oneOf(["me"] as const), dir: oneOf(ME_DIRS), sub: opt(str({ min: 1, max: 200, pattern: /^[A-Za-z0-9 _.-]+(\/[A-Za-z0-9 _.-]+)*$/ })) });
const jobTarget = obj({ kind: oneOf(["job"] as const), company_slug: slug, id: slug, subdir: opt(oneOf(JOB_SUBDIRS)) });
export const inboxTarget: V<InboxTarget> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "me") return meTarget(v, at) as InboxTarget;
  if (kind === "job") return jobTarget(v, at) as InboxTarget;
  throw new ArgError(`${at}.kind must be "me" or "job"`);
};
const settingsChange = obj({ path: settingsPath, value: json });
/** A link kept from a resume: a plain http(s) address. */
const resumeLink = str({ min: 1, max: RESUME_FIELD_MAX.link, pattern: /^https?:\/\/[^\s<>"'`]+$/i });
const resumeValues = obj({
  name: opt(str({ max: RESUME_FIELD_MAX.name })), email: opt(str({ max: RESUME_FIELD_MAX.email })), phone: opt(str({ max: RESUME_FIELD_MAX.phone })),
  city: opt(str({ max: RESUME_FIELD_MAX.city })), links: opt(arr(resumeLink, { max: 5 })),
});

// ---- mail ------------------------------------------------------------------------------------------
// No mail method takes a filesystem path: messages are named by their workspace ref (MAIL_REF_PATTERN),
// attachments by workspace-relative paths, and everything else by slugs and queue ids.
export const mailRef = str({ min: 1, max: 400, pattern: MAIL_REF_PATTERN });
export const mailPart = str({ min: 1, max: 4, pattern: /^\d{1,4}$/ });
export const triageId = str({ min: 1, max: 100, pattern: /^[a-z0-9][a-z0-9-]{0,99}$/ });
export const draftId = queueId;
export const draftIdOrNew: V<string> = (v, at) => (v === "" ? "" : draftId(v, at));
/** A job id, or "" for a draft that belongs to the company itself (a general enquiry to a recruiter). */
export const jobOrCompany: V<string> = (v, at) => (v === "" ? "" : slug(v, at));
export const mailTarget = obj({ company_slug: slug, id: opt(slug) });
export const mailQuery = obj({
  company_slug: opt(slug), id: opt(slug), includeCompany: opt(bool), direction: opt(oneOf(["in", "out"] as const)), unread: opt(bool),
  attachments: opt(bool), text: opt(text(200)), limit: opt(int(1, 500)), offset: opt(int(0, 1_000_000)),
});
export const draftInput = obj({
  to: text(2000), cc: text(2000), subject: text(300), body: note(100_000), attach: arr(relPath, { max: 20 }),
  in_reply_to: text(1000), references: arr(text(1000), { max: 50 }), purpose: oneOf(["", "apply"] as const),
});
/** Background sync interval, in minutes. Matches services' setBackground and the integrations schema (15 to 1440). */
export const backgroundMinutes = int(15, 1440);

const actionTargets: Record<TargetKind, V<unknown>> = {
  workspace: obj({ kind: oneOf(["workspace"] as const) }),
  company: obj({ kind: oneOf(["company"] as const), company_slug: slug }),
  job: obj({ kind: oneOf(["job"] as const), company_slug: slug, id: slug }),
  topic: obj({ kind: oneOf(["topic"] as const), topic: slug, label: str({ min: 1, max: 80, pattern: TOPIC_LABEL }), company_slug: opt(slug), id: opt(slug) }),
  resume_variant: obj({ kind: oneOf(["resume_variant"] as const), variant: variantSlug, label: str({ min: 1, max: 80, pattern: TOPIC_LABEL }) }),
};
/** What a Claude action runs on. Topic labels go into prompts, so they are one line of plain characters. */
export const actionTarget: V<ActionTarget> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && Object.hasOwn(actionTargets, kind)) return actionTargets[kind as TargetKind](v, at) as ActionTarget;
  throw new ArgError(`${at}.kind must be one of: ${TARGET_KINDS.join(", ")}`);
};

/** Request composer options: a small plain object of text, numbers, true/false or short lists of text. */
const requestOptions: V<Record<string, unknown>> = (v, at) => {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new ArgError(`${at} must be an object`);
  const src = v as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length > 12) throw new ArgError(`${at} has too many options`);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!/^[a-z][a-z_]{0,31}$/.test(k) || ["constructor", "prototype"].includes(k)) throw new ArgError(`${at}.${k.slice(0, 40)} is not allowed`);
    const x = src[k];
    if (typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) out[k] = x;
    // 64 fits a slug option (a section or bullet id); select values are much shorter.
    else if (typeof x === "string") out[k] = str({ max: 64 })(x, `${at}.${k}`);
    else out[k] = arr(str({ max: 40 }), { max: 8 })(x, `${at}.${k}`);
  }
  return out;
};

const ttsLang = str({ min: 2, max: 16, pattern: TTS_LANG_CODE });
const ttsOptions = obj({ voice: oneOf(TTS_VOICES), lang: ttsLang, engine: opt(oneOf(["macos_say"] as const)) });
/** The workspace file the spoken text came from ("" when it isn't a file), so locks can be checked. */
/** The switcher's opaque token for a workspace (main maps it back to a folder). */
const workspaceKey = str({ min: 16, max: 16, pattern: /^[0-9a-f]{16}$/ });
const ttsSource: V<string> = (v, at) => (v === "" ? "" : relPath(v, at));
const ttsRequest = str({ min: 1, max: 70, pattern: TTS_REQUEST_ID });

/** Every bridge call and its argument validators, in order. The services validate with this table. */
export const METHODS = {
  "app.info": [],
  "app.updates.state": [],
  "app.updates.check": [],
  // Only once an update is downloaded; main checks again before it restarts the app.
  "app.updates.install": [],
  "app.updates.setAuto": [bool],
  "workspace.current": [],
  "workspace.pickFolder": [oneOf(["create", "open", "legacy"] as const)],
  "workspace.suggest": [],
  // No path from the renderer: main picks the folder for "Get started" and for the example.
  "workspace.start": [],
  // The name may be empty: "Get started" makes the folder first and asks for the name on the next page.
  "workspace.create": [absPath, (v, at) => (v === "" ? "" : segmentName(v, at))],
  "workspace.openSample": [],
  "workspace.open": [absPath],
  "workspace.previewLegacy": [absPath, absPath],
  "workspace.importLegacy": [absPath, absPath],
  "workspace.close": [],
  "workspace.recent": [],
  "workspace.switchTo": [workspaceKey],
  "workspace.forget": [workspaceKey],
  // Only for an empty workspace that isn't open; main checks again and uses the system Trash (never deletes).
  "workspace.trash": [workspaceKey],
  // "Locate…" for a missing folder: the folder the person picked. Accepted only if it is the same workspace (same id).
  "workspace.locate": [workspaceKey, absPath],
  "workspace.addRecent": [absPath],
  // Only a name ("" allowed): main makes the folder from it, inside the home folder.
  "workspace.startNew": [(v, at) => (v === "" ? "" : segmentName(v, at))],
  "home.summary": [],
  "jobs.list": [jobQuery],
  "jobs.get": [slug, slug],
  "jobs.setStatus": [slug, slug, oneOf(JOB_STATUSES), note(500)],
  "jobs.addNote": [slug, slug, requiredNote(2000)],
  "jobs.attach": [slug, slug, absPath, required(120), oneOf(JOB_SUBDIRS)],
  "jobs.views": [],
  "jobs.saveView": [required(60), jobQuery],
  "jobs.deleteView": [required(60)],
  // "Add a job": a link or pasted text (main reads the link by where it points), a dropped file, then the checked preview.
  "jobs.preview": [jobPreviewInput],
  "jobs.previewFile": [absPath],
  "jobs.add": [jobDraftArg, oneOf(JOB_ADD_STATUSES)],
  // A local date and time ("2026-10-21T14:30"), or "" to clear. The record schema checks the same shape.
  "jobs.setInterview": [slug, slug, str({ max: 16, pattern: new RegExp(`^(?:${INTERVIEW_AT.source.slice(1, -1)})?$`) })],
  "jobs.addToCalendar": [slug, slug, oneOf(CALENDAR_KINDS)],
  "jobs.setOffer": [slug, slug, offerArg],
  "apply.state": [slug, slug],
  "apply.prepare": [slug, slug],
  "apply.requestApproval": [slug, slug],
  "apply.markApplied": [slug, slug],
  "inbox.list": [],
  "inbox.overview": [],
  "inbox.add": [arr(absPath, { min: 1, max: 50 })],
  "inbox.file": [fileName, inboxTarget, note(200)],
  // The exact names the person saw and confirmed: main checks each one and never trashes a file that arrived later.
  "inbox.remove": [arr(fileName, { min: 1, max: 200 })],
  "inbox.putBack": [fileName],
  // Claude's look at one file. Main decides what Claude may see (never a file for a locked folder).
  "inbox.ask": [fileName],
  "inbox.addAsJob": [fileName, obj({ company: required(120), title: required(200) })],
  // "Use this to fill my profile": Fill from my resume on one waiting file, named only. Main refuses a file for a locked folder.
  "inbox.readResume": [fileName],
  "inbox.fillProfile": [fileName, resumeValues, arr(oneOf(RESUME_FIELD_KEYS), { max: 5 })],
  "learn.list": [],
  "learn.hub": [],
  "learn.setProgress": [relPath, oneOf(LEARN_PROGRESS)],
  "guide.state": [],
  "guide.setDismissed": [bool],
  "guide.setSkipped": [oneOf(SKIPPABLE_SETUP), bool],
  "tour.state": [],
  "tour.mark": [oneOf(TOUR_IDS), oneOf(TOUR_MARKS)],
  "tour.replayAll": [],
  "tour.setOff": [bool],
  // "Fill from my resume": the dropped or picked file's path, as for inbox.add. Only fields go back, never the text.
  "profile.readResume": [absPath],
  "profile.fillFromResume": [absPath, resumeValues, arr(oneOf(RESUME_FIELD_KEYS), { max: 5 })],
  "profile.fillState": [],
  "profile.markFillSeen": [],
  "profile.suggestions": [],
  "files.readText": [relPath],
  "files.reveal": [relPath],
  "files.preview": [relPath],
  "files.open": [relPath],
  "files.pick": [],
  "sponsors.list": [],
  "companies.list": [],
  "companies.get": [slug],
  "recruiters.list": [],
  "recruiters.update": [slug, agencyPatchArgs as V<unknown>],
  "recruiters.attachResume": [slug, jobOrCompany, str({ min: 12, max: 220, pattern: BASE_RESUME_REL })],
  "recruiters.mailbox": [slug],
  "network.status": [],
  "network.importLinkedIn": [absPath],
  "network.people": [required(200)],
  "network.forget": [],
  "searches.list": [],
  "settings.get": [oneOf(SETTINGS_KINDS)],
  "settings.save": [oneOf(SETTINGS_KINDS), arr(settingsChange, { min: 1, max: 100 })],
  "privacy.get": [],
  "privacy.setLocked": [oneOf(LOCKABLE_DIRS), bool],
  "privacy.allow": [queueId, int(1, 240)],
  "privacy.deny": [queueId],
  "privacy.revoke": [oneOf(LOCKABLE_DIRS)],
  "privacy.acceptFolders": [],
  "privacy.moveBack": [oneOf(LOCKABLE_DIRS)],
  "approvals.list": [],
  "approvals.approve": [queueId, digest],
  "approvals.decline": [queueId, note(500)],
  "secrets.status": [oneOf(SECRET_NAMES)],
  "secrets.set": [oneOf(SECRET_NAMES), required(4096)],
  "secrets.remove": [oneOf(SECRET_NAMES)],
  "links.open": [httpsUrl],
  "claude.openDesktop": [],
  "mail.status": [],
  "mail.testConnection": [str({ min: 3, max: 254 }), text(100), required(64)],
  "mail.saveAccount": [str({ min: 3, max: 254 }), text(100)],
  "mail.disconnect": [],
  "mail.setSignature": [note(2000)],
  "mail.syncNow": [],
  "mail.list": [mailQuery],
  "mail.get": [mailRef],
  "mail.loadImages": [mailRef],
  "mail.saveAttachment": [mailRef, mailPart],
  "mail.move": [mailRef, mailTarget],
  "mail.prune": [int(1, 120)],
  "mail.recheck.preview": [],
  "mail.recheck.apply": [str({ min: 64, max: 64 })],
  "mail.recheck.dismiss": [],
  "mail.triage.list": [],
  "mail.triage.assign": [triageId, mailTarget, bool],
  "mail.triage.createCompany": [triageId, required(120), required(200)],
  "mail.triage.ignore": [triageId, oneOf(["sender", "domain"] as const)],
  "mail.drafts.all": [],
  // A draft belongs to a job, or (job id "") to the company itself: a general enquiry to a recruiter.
  "mail.drafts.list": [slug, jobOrCompany],
  "mail.drafts.get": [slug, jobOrCompany, draftId],
  "mail.drafts.save": [slug, jobOrCompany, draftIdOrNew, draftInput],
  "mail.drafts.propose": [slug, jobOrCompany, draftId],
  "mail.drafts.assist": [slug, slug],
  "mail.send.markSent": [queueId],
  // The services refuse unless this is true: the UI confirms first, because the person may get the email twice.
  "mail.send.again": [queueId, digest, bool],
  "mail.background.status": [],
  "mail.background.set": [bool, backgroundMinutes],
  "video.types": [oneOf(VIDEO_SCREENS)],
  "video.tools": [bool],
  "video.sources": [videoTypeId, videoSubject],
  "video.start": [videoTypeId, videoSubject, videoOptions],
  "video.run": [videoRunId],
  "video.runs": [],
  "video.cancel": [videoRunId],
  "video.draft": [videoFolder],
  "video.saveScript": [videoFolder, videoScriptEdits],
  "video.revise": [videoFolder, note(500)],
  "video.approveScript": [videoFolder],
  "video.render": [videoFolder, oneOf(["draft", "final"] as const)],
  "video.retry": [videoFolder, obj({ skip_check: opt(bool) })],
  "video.list": [videoListFilter],
  "video.delete": [videoFolder],
  "video.exportCaptions": [videoFolder, oneOf(["srt", "vtt"] as const)],
  "video.installTool": [oneOf(INSTALLABLE_TOOLS)],
  "video.takeIntent": [],
  "claude.status": [oneOf(ACTION_IDS), actionTarget],
  "claude.prepare": [oneOf(ACTION_IDS), actionTarget, bool],
  "claude.engine": [bool],
  "claude.consent": [],
  "claude.setAutoMode": [bool],
  "claude.repair": [],
  "claude.openSignIn": [],
  "claude.testRun": [],
  "claude.run": [oneOf(ACTION_IDS), actionTarget, claudeRunRequest],
  "claude.runs": [],
  "claude.cancel": [runId],
  "claude.compose": [oneOf(ACTION_IDS), actionTarget],
  // The shape is checked here; the services check every value against the action's allowlist (validateOptions).
  "claude.saveOptions": [oneOf(ACTION_IDS), actionTarget, requestOptions],
  // Search in my Chrome (lane S). Board lists are ids only; main owns the addresses.
  "chrome.state": [bool],
  "chrome.install": [],
  "chrome.openRemote": [],
  "chrome.connect": [],
  "chrome.showBoard": [oneOf(BOARD_IDS)],
  "chrome.openHome": [oneOf(BOARD_IDS)],
  "chrome.confirmSignIn": [oneOf(BOARD_IDS)],
  // A profile folder name only ("Default", "Profile 2"); main checks it against Chrome's own list.
  "chrome.setProfile": [str({ max: 64, pattern: /^([A-Za-z0-9_()][A-Za-z0-9 _.()-]{0,63})?$/ })],
  "chrome.removeHelper": [],
  "chrome.finish": [arr(oneOf(BOARD_IDS), { min: 1, max: BOARD_IDS.length })],
  "chrome.setBoards": [arr(oneOf(BOARD_IDS), { max: BOARD_IDS.length })],
  "chrome.turnOff": [],
  "chrome.runBoards": [arr(oneOf(BOARD_IDS), { min: 1, max: BOARD_IDS.length })],
  "schedule.get": [],
  "schedule.save": [obj({
    mode: oneOf(["off", "hours", "daily"] as const), every_hours: int(1, 168), times: (v: unknown, at: string) => (v === null ? null : int(1, 100)(v, at)),
    at: str({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }), days: arr(int(0, 6), { max: 7 }),
    since: opt(str({ max: 40 })), last_run_at: opt(str({ max: 40 })), runs: opt(int(0, 100_000)),
    // Shown back as read; saving keeps the stored history and searched_at (schedule.save ignores these).
    searched_at: opt(str({ max: 40 })), history: opt(arr(obj({ at: str({ max: 40 }), text: str({ max: 200 }) }), { max: 10 })),
  }), opt(bool)],
  "chrome.progress": [],
  "chrome.answer": [oneOf(BOARD_IDS), oneOf(["continue", "skip"] as const)],
  "tts.status": [],
  "tts.speak": [requiredNote(MAX_SPEAK_CHARS), ttsOptions, ttsSource, ttsRequest],
  "tts.cancel": [ttsRequest],
  "tts.previews": [],
  "tts.generatePreviews": [ttsLang],
  "tts.previewVoice": [oneOf(TTS_VOICES), ttsLang],
  "tts.activity": [],
  "tts.clearCache": [],
  "tts.downloadVoice": [],
  "tts.installVoice": [],
  "setup.status": [opt(bool)],
  "setup.install": [oneOf(SETUP_TOOLS)],
  "setup.cancel": [],
  "tts.stopVoiceWork": [],
  "docs.state": [slug, slug],
  "docs.export": [slug, slug, arr(oneOf(EXPORT_SOURCES), { min: 1, max: 2 }), arr(oneOf(EXPORT_FORMATS), { min: 1, max: 2 }), bool],
  // A job's tailored resume or a general version (ResumeRef); the file is a plain name in that folder.
  "resume.load": [resumeRef, resumeFile],
  "resume.save": [resumeRef, resumeFile, resumeMarkdown, resumeStyleArg, digest, bool],
  "resume.version": [resumeRef, resumeFile, versionId],
  "resume.restore": [resumeRef, resumeFile, versionId, digest],
  "resume.suggestion": [resumeRef, resumeFile, suggestionDecision, digest],
  "resume.download": [resumeRef, resumeFile, oneOf(RESUME_DOWNLOADS)],
  "resume.copy": [resumeRef, resumeFile, oneOf(RESUME_COPY)],
  "resumes.list": [],
  // A new general version: its name (the focus) only. Main makes resume-variants/<slug>/ and returns the slug.
  "resumes.newVariant": [str({ min: 1, max: 80, pattern: VARIANT_NAME })],
  // A copy of any resume as a new general version (its name, as for newVariant). Main reads the source; nothing else is sent.
  "resumes.duplicate": [resumeItemRef, str({ min: 1, max: 80, pattern: VARIANT_NAME })],
  // Moves a resume to the Trash (recoverable): a tailored resume.md, a general version's folder, or one of the person's files.
  "resumes.remove": [resumeItemRef],
  // Delete: items move to the workspace trash (.backup/trash), never away for good. Named by slugs and checked folder
  // names only; main resolves and checks each one, and one bad target moves nothing. Claude has no tool for these.
  "trash.check": [trashTarget],
  "trash.move": [arr(trashTarget, { min: 1, max: 200 })],
  "trash.list": [],
  "trash.restore": [trashId],
  // "Delete forever": refused unless the second argument is true (the UI confirms first).
  "trash.forget": [trashId, bool],
} as const satisfies Record<string, readonly V<unknown>[]>;

export type MethodName = keyof typeof METHODS;

export function validateArgs(method: string, args: unknown): unknown[] {
  if (typeof method !== "string" || !Object.hasOwn(METHODS, method)) throw new ArgError(`unknown method "${String(method).slice(0, 80)}"`);
  const spec = METHODS[method as MethodName] as readonly V<unknown>[];
  if (!Array.isArray(args)) throw new ArgError(`${method}: arguments must be a list`);
  if (args.length !== spec.length) throw new ArgError(`${method}: expected ${spec.length} argument(s), got ${args.length}`);
  return spec.map((v, i) => v(args[i], `${method} argument ${i + 1}`));
}
