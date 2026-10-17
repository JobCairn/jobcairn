import { ArgError, CHANGE_AREAS, validateArgs, type ChangeArea, type MethodName } from "@careeros/contract";
import { plainError } from "./errors.js";
import { actionHandlers } from "./actions.js";
import { claudeEngineHandlers } from "./claude/index.js";
import { chromeHandlers } from "./chrome/index.js";
import { scheduleHandlers } from "./search-schedule.js";
import { setupHandlers } from "./setup.js";
import { applyHandlers } from "./apply.js";
import { approvalHandlers, mailSendHandlers } from "./approvals.js";
import { composerHandlers } from "./composer.js";
import type { ServiceContext } from "./context.js";
import { docsHandlers } from "./docs.js";
import { fileHandlers } from "./files.js";
import { filePreviewHandlers } from "./file-preview.js";
import type { HandlerTable } from "./handlers.js";
import { inboxHandlers } from "./inbox.js";
import { jobLinkHandlers } from "./joblink/index.js";
import { guideHandlers } from "./guide.js";
import { learnHandlers } from "./learn.js";
import { learnHubHandlers } from "./learn-hub.js";
import { mailAccountHandlers } from "./mail-account.js";
import { mailReadHandlers } from "./mail-read.js";
import { mailAiHandlers } from "./mail-ai.js";
import { mailRecheckHandlers } from "./mail-recheck.js";
import { mailSyncHandlers } from "./mail-sync.js";
import { privacyHandlers } from "./privacy.js";
import { readHandlers } from "./read.js";
import { jobExtraHandlers } from "./job-extras.js";
import { companyHandlers } from "./companies.js";
import { recruiterHandlers } from "./recruiters.js";
import { recruiterAddHandlers } from "./recruiters-add.js";
import { networkHandlers } from "./network.js";
import { resumeHandlers } from "./resume.js";
import { resumesHandlers } from "./resumes.js";
import { researchHandlers } from "./topic-research.js";
import { resumeFillHandlers } from "./resume-fill.js";
import { linkHandlers, secretHandlers } from "./secrets.js";
import { settingsHandlers } from "./settings.js";
import { videoHandlers, videoLearnHandlers } from "./video.js";
import { tourHandlers } from "./tour.js";
import { trashHandlers } from "./trash.js";
import { ttsHandlers } from "./tts.js";
import { switcherHandlers } from "./switcher.js";
import { updateHandlers } from "./updates.js";
import { workspaceHandlers } from "./workspace.js";

export { plainError } from "./errors.js";

export const HANDLERS: HandlerTable = {
  ...workspaceHandlers, ...switcherHandlers, ...readHandlers, ...companyHandlers, ...recruiterHandlers, ...recruiterAddHandlers, ...settingsHandlers, ...fileHandlers, ...filePreviewHandlers, ...inboxHandlers, ...learnHandlers, ...learnHubHandlers, ...guideHandlers,
  ...applyHandlers, ...privacyHandlers, ...approvalHandlers, ...secretHandlers, ...linkHandlers, ...actionHandlers,
  ...docsHandlers, ...claudeEngineHandlers, ...composerHandlers, ...ttsHandlers, ...resumeHandlers, ...tourHandlers, ...videoHandlers, ...videoLearnHandlers, ...chromeHandlers, ...scheduleHandlers,
  ...resumeFillHandlers, ...jobLinkHandlers, ...resumesHandlers, ...researchHandlers, ...trashHandlers,
  ...mailAccountHandlers, ...mailReadHandlers, ...mailAiHandlers, ...mailRecheckHandlers, ...mailSyncHandlers, ...mailSendHandlers,
  ...setupHandlers, ...updateHandlers, ...networkHandlers, ...jobExtraHandlers,
};

const ALL = [...CHANGE_AREAS];

export const MUTATION_AREAS: Partial<Record<MethodName, ChangeArea[]>> = {
  "workspace.create": ALL, "workspace.start": ALL, "workspace.openSample": ALL, "workspace.open": ALL, "workspace.importLegacy": ALL, "workspace.close": ["workspace"],
  "workspace.switchTo": ALL, "workspace.startNew": ALL,
  "workspace.forget": ["workspace"], "workspace.trash": ["workspace"], "workspace.locate": ["workspace"], "workspace.addRecent": ["workspace"],
  "jobs.setStatus": ["jobs", "home"], "jobs.addNote": ["jobs"], "jobs.attach": ["jobs"], "jobs.saveView": ["jobs"], "jobs.deleteView": ["jobs"],
  "jobs.add": ["jobs", "home", "sponsors", "recruiters"], "recruiters.update": ["recruiters"], "recruiters.attachResume": ["jobs"], "recruiters.mailbox": ["jobs", "sponsors"], "recruiters.attachVariant": ["jobs"],
  "recruiters.add": ["recruiters"], "recruiters.importList": ["recruiters"], "recruiters.importFile": ["recruiters"], "recruiters.unlink": ["recruiters"],
  "jobs.setInterview": ["jobs", "home"], "jobs.setOffer": ["jobs"],
  "apply.prepare": ["jobs", "home"], "apply.requestApproval": ["approvals", "home", "jobs"], "apply.markApplied": ["jobs", "home"],
  "apply.stretch": ["jobs"], "apply.saveFact": ["jobs"],
  "inbox.add": ["inbox", "home"], "inbox.file": ["inbox", "home", "jobs"],
  "inbox.remove": ["inbox", "home"], "inbox.putBack": ["inbox", "home"], "inbox.ask": ["inbox", "claude"], "inbox.addAsJob": ["inbox", "home", "jobs"],
  "inbox.fillProfile": ["settings", "jobs", "home", "inbox"],
  "settings.save": ["settings", "jobs", "home"],
  "network.importLinkedIn": ["settings", "jobs"], "network.forget": ["settings", "jobs"],
  "privacy.setLocked": ["privacy"], "privacy.allow": ["privacy", "home"], "privacy.deny": ["privacy", "home"], "privacy.revoke": ["privacy"], "privacy.acceptFolders": ["privacy", "home"], "privacy.moveBack": ["privacy", "home"],
  "approvals.approve": ["approvals", "jobs", "home", "mail"], "approvals.decline": ["approvals", "home"],
  "video.start": ["video", "learn"], "video.saveScript": ["video"], "video.revise": ["video"], "video.approveScript": ["video"],
  "video.render": ["video"], "video.retry": ["video"], "video.cancel": ["video"], "video.delete": ["video", "learn", "jobs", "trash"], "video.installTool": ["video", "setup"], "setup.install": ["setup", "claude", "settings", "video"], "setup.cancel": ["setup"],
  "app.updates.check": ["updates"], "app.updates.setAuto": ["updates"],
  "claude.prepare": ["jobs", "learn", "searches"],
  "docs.export": ["jobs"],
  "claude.consent": ["claude", "settings"], "claude.setAutoMode": ["claude", "settings"], "claude.repair": ["claude", "settings"], "claude.run": ["claude"], "claude.testRun": ["claude"], "claude.cancel": ["claude"], "tts.generatePreviews": ["settings"], "tts.previewVoice": ["settings"],
  "resume.save": ["jobs"], "resume.restore": ["jobs"], "resume.suggestion": ["jobs"], "resumes.newVariant": ["jobs"], "resumes.duplicate": ["jobs"], "resumes.remove": ["jobs", "home", "trash"],
  "research.create": ["learn"], "research.update": ["learn"], "research.exportHtml": ["learn"], "research.exportPdf": ["learn"],
  "profile.fillFromResume": ["settings", "jobs", "home"], "profile.markFillSeen": ["settings", "home"],
  "learn.setProgress": ["learn", "home"], "guide.setDismissed": ["home", "learn"], "guide.setSkipped": ["home", "learn"],
  // mail.get marks a message opened, which changes Home's unread count; the open message itself doesn't need a reload.
  "mail.get": ["home"], "mail.saveAccount": ["mail", "settings", "home"], "mail.disconnect": ["mail", "settings", "home"],
  "mail.setSignature": ["mail", "settings"], "mail.syncNow": ["mail", "jobs", "home"], "mail.loadImages": ["mail"],
  "mail.saveAttachment": ["mail", "jobs"], "mail.move": ["mail", "jobs", "home"], "mail.prune": ["mail"], "mail.recheck.apply": ["mail", "jobs", "home"], "mail.recheck.dismiss": ["mail"],
  "mail.triage.assign": ["mail", "jobs", "home"], "mail.triage.createCompany": ["mail", "jobs", "home", "sponsors"], "mail.triage.ignore": ["mail"], "mail.triage.linkAgency": ["mail", "recruiters", "jobs"],
  "mail.drafts.save": ["mail"], "mail.drafts.propose": ["mail", "approvals", "home"], "mail.background.set": ["mail"],
  "mail.send.markSent": ["mail", "approvals", "jobs", "home"], "mail.send.again": ["mail", "approvals", "jobs", "home"],
  "secrets.set": ["mail"], "secrets.remove": ["mail"],
  "trash.move": ["jobs", "home", "learn", "video", "mail", "sponsors", "trash"], "trash.restore": ["jobs", "home", "learn", "video", "mail", "sponsors", "trash"],
  "trash.forget": ["trash"],
  "chrome.finish": ["settings"], "chrome.setBoards": ["settings"], "chrome.turnOff": ["settings"],
  "schedule.save": ["settings"],
};

/** The only entry point from a shell. Validates, runs, then announces what changed. Errors leave as plain text. */
export async function dispatch(ctx: ServiceContext, method: string, args: unknown): Promise<unknown> {
  let clean: unknown[];
  try {
    clean = validateArgs(method, args);
  } catch (err) {
    // Contract errors keep their class and message, but never V8's stack (it names install paths).
    if (err instanceof ArgError) { err.stack = `ArgError: ${err.message}`; throw err; }
    throw plainError(err, [ctx.root]);
  }
  const before = ctx.root;
  let result: unknown;
  try {
    result = await HANDLERS[method as MethodName](ctx, ...clean);
  } catch (err) {
    throw plainError(err, [before, ctx.root]);
  }
  const areas = MUTATION_AREAS[method as MethodName];
  if (areas) ctx.emit(...areas); // emit isolates each listener, so a broken listener can't fail a done mutation
  return result;
}
