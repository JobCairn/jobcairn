export * from "./host.js";
export * from "./fakes.js";
export * from "./context.js";
export * from "./handlers.js";
export * from "./workspace.js";
export * from "./switcher.js";
export { ensureWorkspaceId, isWorkspaceId, recentKey } from "./workspace-registry.js";
export * from "./read.js";
// Named, not `export *`: settings.js also exports `setPath`, a raw path writer with no schema
// allowlist of its own (the allowlist lives in `save()`, which calls it). It's exported from
// that module only so its own prototype-pollution safety can be unit-tested directly; it must
// not be part of this package's public surface.
export { settingsFile, settingsHandlers } from "./settings.js";
export * from "./files.js";
export * from "./inbox.js";
export * from "./learn.js";
export * from "./learn-hub.js";
export * from "./guide.js";
export * from "./apply.js";
export * from "./privacy.js";
export * from "./approvals.js";
export * from "./secrets.js";
export * from "./dispatch.js";
export * from "./watcher.js";
export * from "./runtime.js";
export * from "./mail-account.js";
export * from "./mail-read.js";
export * from "./mail-sync.js";
export * from "./mail-send.js";
export * from "./video.js";
export * from "./video-claude.js";
export { videoFlow, type VideoFlow } from "./claude/video.js";
export * from "./fakes-video.js";
export * from "./actions.js";
export * from "./docs.js";
export * from "./claude/index.js";
export { ttsHandlers, resolveTtsMedia, installTtsHooks, purgeEphemeral, setTtsDeps } from "./tts.js";
export * from "./analytics.js";
export * from "./resume.js";
export * from "./chrome/index.js";
export * from "./setup.js";
export * from "./install-error.js";
export * from "./toolchain.js";
export * from "./install-lock.js";
