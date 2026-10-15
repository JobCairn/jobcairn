import { layout, readRecord } from "@careeros/core";
import {
  ACTIONS, defaultOptions, deriveTarget, optionsFor, ownTarget, skillSuggestions, videoFolderN,
  type ActionId, type ActionTarget, type ComposeView, type OptionValue,
} from "@careeros/contract";
import { actionStatus, promptInfo, workRightsStatus } from "./actions.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { jobDetail } from "./read.js";
import { saveOptions, savedOptions } from "./request-store.js";

/** Skill chips: the job's must-haves and nice-to-haves, then the profile's target keywords. Never the locked folders. */
function suggestions(root: string, id: ActionId, t: ActionTarget): string[] {
  if (!optionsFor(id).some((o) => o.kind === "chips" && o.suggest === "skills")) return [];
  const job = deriveTarget(t, "job");
  let fit: { must_haves?: unknown[]; nice_to_haves?: unknown[] } | null = null;
  if (job?.kind === "job") { try { fit = jobDetail(root, job.company_slug, job.id).job.scores.fit; } catch { fit = null; } }
  let keywords: unknown = [];
  try { keywords = (readRecord("profile", layout(root).profile) as unknown as { targets?: { keywords?: unknown } }).targets?.keywords; } catch { keywords = []; }
  return skillSuggestions(fit, keywords);
}

function view(ctx: ServiceContext, id: ActionId, target: ActionTarget): ComposeView {
  const root = ctx.requireRoot();
  const t = ownTarget(id, target);
  const now = ctx.now().toISOString();
  const info = { ...promptInfo(root, t), now };
  // A video goes in the folder its status shows (the open request's, or the next free one).
  const n = ACTIONS[id].group === "video" ? videoFolderN(id, t, info, actionStatus(ctx, id, t).folder) ?? 1 : 1;
  const status = info.work_rights ?? "unknown";
  const saved = savedOptions(root, id, t, status);
  const chips = suggestions(root, id, t);
  const options = saved ?? defaultOptions(id, status);
  return { info: { ...info, n }, options, saved: saved !== null, suggestions: chips };
}

function save(ctx: ServiceContext, id: ActionId, target: ActionTarget, options: Record<string, OptionValue>): ComposeView {
  const root = ctx.requireRoot();
  const t = ownTarget(id, target);
  const chips = suggestions(root, id, t);
  // Skill chips must be ones the app offered for this job; anything else is dropped.
  const clean: Record<string, OptionValue> = { ...options };
  const status = workRightsStatus(root);
  for (const o of optionsFor(id, status)) if (o.kind === "chips" && o.suggest === "skills" && Array.isArray(clean[o.key])) {
    clean[o.key] = (clean[o.key] as string[]).filter((c) => chips.includes(c));
  }
  saveOptions(root, id, t, clean, status);
  return view(ctx, id, t);
}

export const composerHandlers = {
  "claude.compose": view,
  "claude.saveOptions": save,
} satisfies Partial<HandlerTable>;
