import fs from "node:fs";
import path from "node:path";
import { layout, readRecord } from "@careeros/core";
import { guideState, isSkippableSetup, learnEntries, prefsMissing, type GuideFacts, type GuideJob, type GuideState, type SetupStepId } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { readSearchPrefs } from "./find-jobs.js";
import type { HandlerTable } from "./handlers.js";
import { learnList } from "./learn.js";
import { jobFacts, readStateFile, writeStateFile, type JobFacts } from "./learn-hub.js";
import { isExampleMail, mailConnected } from "./mail-account.js";

/**
 * `.careeros/guide.json`: the workspace's own settings for the first-run checklists: hidden or not, and which
 * optional Set up steps were skipped. Anything unknown in it is ignored.
 */
const guideFile = (root: string) => path.join(root, ".careeros", "guide.json");

interface GuideFile { dismissed: boolean; skipped: SetupStepId[] }

function readGuide(root: string): GuideFile {
  const raw = readStateFile(guideFile(root));
  const r = typeof raw === "object" && raw !== null ? (raw as { dismissed?: unknown; skipped?: unknown }) : {};
  return { dismissed: r.dismissed === true, skipped: Array.isArray(r.skipped) ? [...new Set(r.skipped.filter(isSkippableSetup))] : [] };
}

function writeGuide(ctx: ServiceContext, root: string, g: GuideFile): void {
  writeStateFile(root, "guide.json", `${JSON.stringify({ ...g, at: ctx.now().toISOString() }, null, 2)}\n`);
}

/** me/resumes holds at least one regular file (one folder level deep). me/resumes is never a locked folder. */
function hasResume(root: string): boolean {
  const dir = layout(root).me("resumes");
  const any = (d: string, depth: number): boolean => {
    let names: string[];
    try { if (!fs.lstatSync(d).isDirectory()) return false; names = fs.readdirSync(d); } catch { return false; }
    return names.some((n) => {
      if (n.startsWith(".")) return false;
      try {
        const st = fs.lstatSync(path.join(d, n));
        return st.isFile() || (depth > 0 && st.isDirectory() && !st.isSymbolicLink() && any(path.join(d, n), depth - 1));
      } catch { return false; }
    });
  };
  return any(dir, 1);
}

const ref = (j: JobFacts | undefined): GuideJob | null => (j ? { company_slug: j.company_slug, id: j.id, title: j.title, company_name: j.company_name } : null);
const OPEN = new Set(["Found", "Saved"]);

export function guideFacts(ctx: ServiceContext): GuideFacts {
  const root = ctx.requireRoot();
  const profile = readRecord("profile", layout(root).profile);
  const jobs = jobFacts(ctx, root);
  const open = jobs.filter((j) => j.eligible && OPEN.has(j.status) && !j.preparing);
  return {
    profile: profile.contact.name.trim() !== "",
    resume: hasResume(root),
    prefs: prefsMissing(readSearchPrefs(root)).length === 0,
    jobs: jobs.length,
    scored: jobs.filter((j) => j.scored).length,
    nextToScore: ref(open.find((j) => !j.scored) ?? jobs.find((j) => !j.scored && j.eligible) ?? jobs.find((j) => !j.scored)),
    preparing: jobs.filter((j) => j.preparing).length,
    nextToPrepare: ref(open.find((j) => j.scored) ?? open[0]),
    learning: learnEntries(learnList(ctx), {}, () => "").length,
    // The example has its own made-up mail, so its "Set up email" step counts as done.
    ...(ctx.host.mail ? { email: mailConnected(ctx, root) || isExampleMail(root) } : {}),
  };
}

function state(ctx: ServiceContext): GuideState {
  const g = readGuide(ctx.requireRoot());
  return guideState(guideFacts(ctx), g.dismissed, g.skipped);
}

function setDismissed(ctx: ServiceContext, value: boolean): GuideState {
  const root = ctx.requireRoot();
  writeGuide(ctx, root, { ...readGuide(root), dismissed: value });
  return state(ctx);
}

/** Skip an optional Set up step (or bring it back). Only skippable steps are kept. */
function setSkipped(ctx: ServiceContext, id: SetupStepId, value: boolean): GuideState {
  const root = ctx.requireRoot();
  const g = readGuide(root);
  const skipped = g.skipped.filter((x) => x !== id);
  writeGuide(ctx, root, { ...g, skipped: value && isSkippableSetup(id) ? [...skipped, id] : skipped });
  return state(ctx);
}

export const guideHandlers = {
  "guide.state": state,
  "guide.setDismissed": setDismissed,
  "guide.setSkipped": setSkipped,
} satisfies Partial<HandlerTable>;
