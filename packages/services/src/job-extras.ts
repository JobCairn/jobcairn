import fs from "node:fs";
import path from "node:path";
import { insideRoot, jobFilePath, layout, readRecord, updateRecord, writeFileAtomic } from "@careeros/core";
import { buildIcs, jobCalendarEvent, offerOf, type CalendarKind, type JobDetail, type JobRecord, type OfferDetails } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { jobDetail, jobDirRel, touch } from "./read.js";

/** Sets or clears the interview's local date and time, and notes it on the timeline. */
function setInterview(ctx: ServiceContext, slug: string, id: string, at: string): JobDetail {
  const root = ctx.requireRoot();
  const file = jobFilePath(root, slug, id);
  const when = ctx.now().toISOString();
  updateRecord("job", file, (j) => {
    if ((j.interview_at ?? "") === at) return;
    j.interview_at = at;
    j.timeline.push({ at: when, event: at ? "Interview set" : "Interview cleared", note: at ? at.replace("T", " ") : "" });
  });
  touch(root, jobDirRel(slug, id));
  return jobDetail(root, slug, id);
}

/**
 * "Add to Calendar": the interview or follow-up as an .ics file in the job's calendar folder, opened with the
 * computer's calendar app (which asks before adding it). Nothing leaves the computer.
 */
async function addToCalendar(ctx: ServiceContext, slug: string, id: string, kind: CalendarKind): Promise<void> {
  const root = ctx.requireRoot();
  const file = jobFilePath(root, slug, id);
  const job = readRecord("job", file) as unknown as JobRecord;
  let company = slug;
  try { company = readRecord("company", layout(root).companyFile(slug)).name || slug; } catch { /* the slug will do */ }
  const ev = jobCalendarEvent(job, company, kind, ctx.now());
  if (!ev) throw new Error(kind === "interview" ? "Set the interview date and time first." : "A follow-up date shows once you've applied.");
  const out = path.join(path.dirname(file), "calendar", `${kind === "interview" ? "interview" : "follow-up"}.ics`);
  // Never write through a link planted in the job folder.
  const dir = path.dirname(out);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("The job's calendar folder is a link. Remove it and try again.");
  if (fs.existsSync(out) && fs.lstatSync(out).isSymbolicLink()) throw new Error("The calendar file is a link. Remove it and try again.");
  if (!insideRoot(root, path.dirname(file))) throw new Error("refusing to write outside the workspace");
  writeFileAtomic(out, buildIcs(ev));
  if (!ctx.host.shell.openPath) throw new Error("Opening the calendar isn't available here. The file is in the job's calendar folder.");
  await ctx.host.shell.openPath(out);
}

/** Saves an offer's details on the job, for Compare offers. A note on the timeline the first time only. */
function setOffer(ctx: ServiceContext, slug: string, id: string, offer: OfferDetails): JobDetail {
  const root = ctx.requireRoot();
  const file = jobFilePath(root, slug, id);
  const clean = offerOf(offer);
  updateRecord("job", file, (j) => {
    if (!j.offer) j.timeline.push({ at: ctx.now().toISOString(), event: "Offer details added", note: "" });
    j.offer = { ...clean };
  });
  touch(root, jobDirRel(slug, id));
  return jobDetail(root, slug, id);
}

export const jobExtraHandlers = {
  "jobs.setInterview": setInterview,
  "jobs.addToCalendar": addToCalendar,
  "jobs.setOffer": setOffer,
} satisfies Partial<HandlerTable>;
