// Named re-exports, matching the package's "no export *" rule for new modules (see match.ts
// below): mime.ts's full public surface is just these two functions.
export { buildMime, envelopeFor } from "./mime.js";
export * from "./redact.js";
export * from "./sanitize.js";
// Named re-exports rather than `export *` (fix round 2, ruling 7): `cleanAddress` is exported
// from "./parse.js" only for that module's own test file to import directly, and must not leak
// into this package's public API (see the `@internal` note on its export in parse.ts).
export type { ParsedAttachment, ParsedMessage } from "./parse.js";
export { MailParseError, authResult, normalizeSubject, parseMessage, syntheticMessageId } from "./parse.js";
export * from "./testing.js";
// Named re-exports rather than `export *`, matching the parse.js convention above (and the
// package's "no export *" rule for new modules): everything match.ts actually offers as public
// API is listed explicitly, so the package entry point's surface is an exact, reviewable list.
export type { CompanyInfo, HeaderInfo, IgnoreList, JobInfo, JobSenders, MatchResult } from "./match.js";
export { RECHECK_VERSION, recheckFiled, type FiledEmail, type RecheckOutcome } from "./recheck.js";
export {
  JOB_SENDERS, coreName, counterparts, domainMatches, domainOf, isIgnored, isJobRelated,
  isSystemAddress, matchCompany, matchMessage, pickJob, suggestCompany, websiteDomain,
} from "./match.js";
// Task 9: named re-exports, matching the rule above.
export type {
  GmailDeps, HeaderSummary, ImapClient, ImapOptions, MailAccount, MailboxInfo, MailErrorKind, MailProvider, MailSession, ProviderCheck,
  SmtpClient, SmtpOptions,
} from "./provider.js";
export { GMAIL, GMAIL_HOSTS, GmailProvider, HEADER_CHUNK, MailError, explainMailError, uidSet, type MailDelivery } from "./provider.js";
export type { FakeMessage } from "./fake.js";
export { FakeMailProvider, MAX_FIXTURE_BYTES, fakeProviderFromFile } from "./fake.js";
export type { FetchInit, Fetcher, ImageCache, ImageCacheEntry, RequestFn, Resolver } from "./images.js";
export {
  IMAGE_TYPES, IMAGE_USER_AGENT, ImageFetchError, MAX_IMAGE_BYTES, checkImageUrl, fetchRemoteImage, guardedLookup, imageCacheKey,
  isBlockedAddress, nodeImageFetcher, sniffImageType,
} from "./images.js";
// Task 10: named re-exports, matching the rule above. `_storeFaults` is a test seam and stays out.
export type { MailPaths, StoreInput, StoreTarget } from "./store.js";
export {
  MAIL_REF, MAX_STORED_RAW_BYTES, UNTRUSTED_NOTE, asciiSlug, baseNameFor, cleanOrphans, deleteStored, isRisky, isStagingRef, knownMessageIds, listTriage,
  markdownBody, messageIdFor, moveMessage, pruneRaw, purgeTriage, rawBytes, readSnippet, readStored, renderMarkdown, resolveMailRef, safeFileName, saveAttachmentFile,
  storeMessage, updateStored,
} from "./store.js";
// Task 11: named re-exports, matching the rule above.
export type { MailState, MailboxState, SyncCaps, SyncCounts, SyncOptions, SyncResult } from "./sync.js";
export { DEFAULT_CAPS, SYNC_STOPPED, SyncBusyError, WorkspaceError, acquireLock, companyIndex, readMailState, syncMail, writeMailState } from "./sync.js";
// Task 12: named re-exports, matching the rule above (fix round 1, ruling 3: the package
// convention wins over the brief's `export *`).
export type { BackgroundScheduler, OsHost, ScheduleSpec } from "./scheduler/index.js";
export {
  SYSTEMD_UNIT, TASK_NAME, createScheduler, launchdPlist, nodeOsHost, systemdArg, systemdService, systemdTimer, taskSchedulerXml, taskXmlBytes, windowsArg,
} from "./scheduler/index.js";
