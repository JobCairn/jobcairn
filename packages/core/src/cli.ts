#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkDraft, parseAddressList, proposeEmailSend, workspaceRel, writeDraft } from "./drafts.js";
import { addConfirmedFact, confirmedFactsRel } from "./facts.js";
import { buildIndex } from "./index-db.js";
import { fileInboxItem, type InboxTarget, listInbox } from "./inbox.js";
import { addEvent, attachFile, type JobSubdir, newJob, setStatus } from "./jobs.js";
import { appendSearch, ranRecently } from "./knowledge.js";
import { importLegacy } from "./legacy.js";
import { migrate } from "./migrate.js";
import type { MeDir } from "./paths.js";
import { expireGrantsAndLog, workspaceSourceFile } from "./privacy.js";
import { listAccessRequests, listApprovals, proposeApproval, requestAccess } from "./queue.js";
import type { ApprovalStatus, JobSource, RequestStatus } from "./types.js";
import { validateWorkspace } from "./validate.js";
import { initWorkspace, isWorkspace } from "./workspace.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

const USAGE = `careeros <command>
  init <dir> [--name NAME]
  job new --company C --title T [--url U --source ats|adzuna|browser|pasted --site S --location L --work-mode M --job-type J --salary S --posted P --apply-via A --jd-file F]
  job event <company_slug> <id> <event> [--note N]
  job status <company_slug> <id> <status> [--note N]
  job attach <company_slug> <id> <file> --label L [--subdir application|emails|interview]
  inbox list | inbox file <name> (--me DIR[/SUB] | --job SLUG/ID [--subdir S]) [--note N]
  search add --site S --query Q --location L [--results N --kept N --notes N]
  search check --site S --query Q --location L
  approval propose --action status_change --job SLUG/ID --status S [--note N --title T] | approval list [--status S]
  request access --folder identity|employment --why W [--field F --minutes N] | request list
    (--folder also takes me/identity or me/employment)
  mail draft --job SLUG/ID --to A [--cc C] --subject S --body-file F [--attach PATH]... [--in-reply-to ID]
  fact add <fact> [--from WHERE]   (a fact you confirmed, saved to me/history/confirmed-facts.md)
  privacy expire
  index | validate | migrate
  import-legacy <legacy-dir> --to <dir> [--dry-run]
All workspace commands accept --ws DIR (default: $CAREEROS_WORKSPACE, then the current folder).`;

// Shown on any usage error (unknown flag, unknown command, missing required flag).
// Kept to a single line so --err stays grep-able and scriptable.
const USAGE_HINT = 'run "careeros --help" for usage';

/**
 * Short names for the locked folders. Claude's deny rules block any command containing "me/identity" or
 * "me/employment", including the request for access itself, so the documented command uses these instead.
 * The full paths still work for people and for the app.
 */
export const FOLDER_ALIASES: Readonly<Record<string, string>> = { identity: "me/identity", employment: "me/employment" };

function folderArg(v: string): string {
  const folder = Object.hasOwn(FOLDER_ALIASES, v) ? FOLDER_ALIASES[v]! : v;
  if (!Object.values(FOLDER_ALIASES).includes(folder)) {
    throw new Error(`--folder must be identity or employment (or me/identity, me/employment) -- ${USAGE_HINT}`);
  }
  return folder;
}

const OPTIONS = {
  ws: { type: "string" }, name: { type: "string" }, company: { type: "string" }, title: { type: "string" },
  url: { type: "string" }, source: { type: "string" }, site: { type: "string" }, location: { type: "string" },
  "work-mode": { type: "string" }, "job-type": { type: "string" }, salary: { type: "string" }, posted: { type: "string" },
  "apply-via": { type: "string" }, "jd-file": { type: "string" }, note: { type: "string" }, label: { type: "string" },
  subdir: { type: "string" }, me: { type: "string" }, job: { type: "string" }, query: { type: "string" },
  results: { type: "string" }, kept: { type: "string" }, notes: { type: "string" }, to: { type: "string" },
  action: { type: "string" }, status: { type: "string" }, folder: { type: "string" }, why: { type: "string" },
  field: { type: "string" }, minutes: { type: "string" }, from: { type: "string" },
  cc: { type: "string" }, subject: { type: "string" }, "body-file": { type: "string" }, attach: { type: "string", multiple: true }, "in-reply-to": { type: "string" },
  "dry-run": { type: "boolean" }, help: { type: "boolean" },
} as const;

// Strips a trailing stack trace (if any made it onto an Error's message) and
// collapses whatever remains onto a single line: err must stay grep-able and
// must never leak a stack trace to the caller.
function oneLine(message: string): string {
  return message.split("\n")[0]!.trim();
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  const ok = (v: unknown, code = 0) => ({ code, out: JSON.stringify(v, null, 2) + "\n", err: "" });
  try {
    let o: Partial<Record<keyof typeof OPTIONS, string | boolean | string[]>>;
    let p: string[];
    try {
      const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
      o = parsed.values;
      p = parsed.positionals;
    } catch (e) {
      // node:util throws TypeError for an unknown flag or a flag used with the wrong arity.
      throw new Error(`${oneLine((e as Error).message)} -- ${USAGE_HINT}`);
    }
    if (o.help || p.length === 0) return { code: 0, out: USAGE + "\n", err: "" };

    const ws = path.resolve((o.ws as string | undefined) ?? env.CAREEROS_WORKSPACE ?? process.cwd());
    const need = (v: string | boolean | string[] | undefined, flag: string): string => {
      if (!v || typeof v !== "string") throw new Error(`missing --${flag} -- ${USAGE_HINT}`);
      return v;
    };
    const arg = (i: number, what: string) => {
      const v = p[i];
      if (!v) throw new Error(`missing ${what} -- ${USAGE_HINT}`);
      return v;
    };
    // Guard for commands that read or write workspace records directly (not via
    // a job lookup, which already reports "no job ..." on its own). init and
    // import-legacy create/target a workspace, so they are exempt; job event
    // and job status are exempt too since jobFilePath already gives a clear
    // "no job <slug>/<id>" error on an uninitialised folder.
    const requireWorkspace = () => {
      if (!isWorkspace(ws)) {
        throw new Error(`"${ws}" is not a ${identity.name} workspace (run "careeros init ${ws}" first)`);
      }
    };
    const [cmd, sub] = p;

    if (cmd === "init") { const dir = path.resolve(arg(1, "<dir>")); initWorkspace(dir, { name: o.name as string | undefined }); return ok({ workspace: dir }); }
    if (cmd === "job" && sub === "new") {
      requireWorkspace();
      let jdText: string | undefined;
      if (o["jd-file"]) {
        // Inside the workspace only, never a locked folder, a link or a second name (workspaceSourceFile).
        jdText = fs.readFileSync(workspaceSourceFile(ws, path.resolve(o["jd-file"] as string)), "utf8");
      }
      return ok(newJob(ws, {
        company: need(o.company, "company"), title: need(o.title, "title"), url: o.url as string | undefined,
        source: o.source as JobSource | undefined, source_site: o.site as string | undefined, location: o.location as string | undefined,
        work_mode: o["work-mode"] as string | undefined, job_type: o["job-type"] as string | undefined, salary_text: o.salary as string | undefined,
        posted: o.posted as string | undefined, apply_via: o["apply-via"] as string | undefined, jd_text: jdText,
      }));
    }
    if (cmd === "job" && sub === "event") return ok(addEvent(ws, arg(2, "<company_slug>"), arg(3, "<id>"), arg(4, "<event>"), (o.note as string | undefined) ?? ""));
    if (cmd === "job" && sub === "status") return ok(setStatus(ws, arg(2, "<company_slug>"), arg(3, "<id>"), arg(4, "<status>"), (o.note as string | undefined) ?? ""));
    if (cmd === "job" && sub === "attach") {
      requireWorkspace();
      const src = workspaceSourceFile(ws, path.resolve(arg(4, "<file>")));
      return ok({ path: attachFile(ws, arg(2, "<company_slug>"), arg(3, "<id>"), src, { label: need(o.label, "label"), subdir: (o.subdir ?? "") as JobSubdir }) });
    }
    if (cmd === "inbox" && sub === "list") { requireWorkspace(); return ok(listInbox(ws)); }
    if (cmd === "inbox" && sub === "file") {
      requireWorkspace();
      let target: InboxTarget;
      if (o.me) { const [dir, ...rest] = (o.me as string).split("/"); target = { kind: "me", dir: dir as MeDir, sub: rest.join("/") || undefined }; }
      else if (o.job) { const [company_slug = "", id = ""] = (o.job as string).split("/"); target = { kind: "job", company_slug, id, subdir: (o.subdir ?? "") as JobSubdir }; }
      else throw new Error(`inbox file needs --me or --job -- ${USAGE_HINT}`);
      return ok(fileInboxItem(ws, arg(2, "<name>"), target, (o.note as string | undefined) ?? ""));
    }
    if (cmd === "search" && sub === "add") {
      requireWorkspace();
      return ok(appendSearch(ws, { site: need(o.site, "site"), query: need(o.query, "query"), location: need(o.location, "location"), results: o.results as string | undefined, kept: o.kept as string | undefined, notes: o.notes as string | undefined }));
    }
    if (cmd === "search" && sub === "check") {
      requireWorkspace();
      const hit = ranRecently(ws, need(o.site, "site"), need(o.query, "query"), need(o.location, "location"));
      return hit ? ok({ ran_recently: true, entry: hit }, 1) : ok({ ran_recently: false });
    }
    if (cmd === "approval" && sub === "propose") {
      requireWorkspace();
      if (need(o.action, "action") !== "status_change") throw new Error(`the CLI can only propose status_change; the app creates the others -- ${USAGE_HINT}`);
      const [company_slug = "", id = ""] = need(o.job, "job").split("/");
      const status = need(o.status, "status");
      const note = (o.note as string | undefined) ?? "";
      return ok(proposeApproval(ws, {
        action: "status_change", title: (o.title as string | undefined) ?? `Change ${company_slug}/${id} to ${status}`,
        summary: note, steps: [`Set the job status to ${status}`, `Add a timeline event "Status: ${status}"`],
        payload: { company_slug, id, status, note }, created_by: "cli",
      }));
    }
    if (cmd === "approval" && sub === "list") { requireWorkspace(); return ok(listApprovals(ws, { status: o.status as ApprovalStatus | undefined })); }
    if (cmd === "request" && sub === "access") {
      requireWorkspace();
      const minutes = o.minutes === undefined ? undefined : Number(o.minutes);
      if (minutes !== undefined && !Number.isInteger(minutes)) throw new Error(`--minutes must be a whole number -- ${USAGE_HINT}`);
      return ok(requestAccess(ws, { folder: folderArg(need(o.folder, "folder")), why: need(o.why, "why"), field: o.field as string | undefined, minutes }));
    }
    if (cmd === "request" && sub === "list") { requireWorkspace(); return ok(listAccessRequests(ws, { status: o.status as RequestStatus | undefined })); }
    if (cmd === "index") { requireWorkspace(); return ok(buildIndex(ws)); }
    if (cmd === "validate") { requireWorkspace(); const issues = validateWorkspace(ws); return ok(issues, issues.length ? 1 : 0); }
    if (cmd === "migrate") { requireWorkspace(); return ok(migrate(ws)); }
    if (cmd === "import-legacy") {
      return ok(importLegacy(path.resolve(arg(1, "<legacy-dir>")), path.resolve(need(o.to, "to")), { dryRun: (o["dry-run"] as boolean | undefined) ?? false }));
    }
    if (cmd === "mail" && sub === "draft") {
      requireWorkspace();
      const jobParts = need(o.job, "job").split("/");
      if (jobParts.length !== 2) throw new Error(`--job must be SLUG/ID -- ${USAGE_HINT}`);
      const [company_slug = "", id = ""] = jobParts;
      // Same rule as --jd-file (workspaceSourceFile): its real path is inside the workspace, outside the locked
      // folders and the app's internals, and it is one regular file with one name (no link, no second hard link).
      const bodyReal = workspaceSourceFile(ws, path.resolve(need(o["body-file"], "body-file")));
      if (fs.statSync(bodyReal).size > 100_000) throw new Error("--body-file is larger than 100 KB");
      const bodyText = fs.readFileSync(bodyReal, "utf8");
      const attach = ((o.attach as string[] | undefined) ?? []).map((p) => workspaceRel(ws, p));
      const draft = checkDraft({
        to: parseAddressList(need(o.to, "to")), cc: parseAddressList((o.cc as string | undefined) ?? ""), subject: need(o.subject, "subject"),
        attach, in_reply_to: (o["in-reply-to"] as string | undefined) ?? "", references: [], purpose: "", body: bodyText,
      }, true);
      const saved = writeDraft(ws, company_slug, id, draft);
      // Never leave an orphan draft on disk: if proposing the send fails for any
      // reason (no Gmail account, attachment now unreadable, etc.), delete what we
      // just wrote rather than leaving a draft with no proposal behind it.
      try {
        return ok({ draft: saved, approval: proposeEmailSend(ws, company_slug, id, saved.draft_id, "cli") });
      } catch (e) {
        fs.rmSync(path.join(ws, saved.rel), { force: true });
        throw e;
      }
    }
    if (cmd === "fact" && sub === "add") {
      requireWorkspace();
      const added = addConfirmedFact(ws, arg(2, "<fact>"), (o.from as string | undefined) ?? "");
      return ok({ added, file: confirmedFactsRel() });
    }
    if (cmd === "privacy" && sub === "expire") { requireWorkspace(); return ok(expireGrantsAndLog(ws)); }
    throw new Error(`unknown command "${p.join(" ")}" -- ${USAGE_HINT}`);
  } catch (e) {
    // Never forward a stack trace: only the Error's own message, flattened to one line.
    return { code: 2, out: "", err: `careeros: ${oneLine((e as Error).message)}\n` };
  }
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1] ?? "")).href; } catch { return false; }
})();
if (invokedDirectly) {
  const r = run(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exit(r.code);
}
