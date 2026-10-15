import { addEvent, listApprovals, logActivity, readApproval, setApprovalNote, setApprovalStatus, setStatus, type Approval } from "@careeros/core";
import type { ApprovalView, JobStatus } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import { plainError } from "./errors.js";
import { resolveWorkspaceFile } from "./files.js";
import type { HandlerTable } from "./handlers.js";
import { appApprovals, approvalDigest, approvalView, jobDirRel, touch } from "./read.js";
import { isSafeLink } from "./secrets.js";
import { withEmail } from "./mail-read.js";
import { CONFIRM_AGAIN, FoundInSentError, markSent, NOT_WAITING, sendEmailApproval, SendRefusedError, sendState, SendUnsureError, UNSURE } from "./mail-send.js";

const running = new Set<string>();

async function execute(ctx: ServiceContext, a: Approval, root: string): Promise<string> {
  const p = a.payload as { company_slug?: string; id?: string; status?: JobStatus; note?: string; url?: string };
  const slug = String(p.company_slug ?? "");
  const id = String(p.id ?? "");
  if (a.action === "status_change") {
    setStatus(root, slug, id, String(p.status), p.note ?? "", ctx.clock());
    touch(root, jobDirRel(slug, id));
    return `Status set to ${p.status}`;
  }
  if (a.action === "apply_handoff") {
    const url = typeof p.url === "string" && isSafeLink(p.url) ? p.url : "";
    const dir = resolveWorkspaceFile(ctx, `${jobDirRel(slug, id)}/application`, "reveal");
    // The shell shows the full address first; if the person says no, nothing is handed off.
    if (url && !(await ctx.host.shell.openExternal(url))) throw new Error("You cancelled opening the link.");
    ctx.host.shell.showItemInFolder(dir);
    addEvent(root, slug, id, "Handed off", url, ctx.clock());
    touch(root, jobDirRel(slug, id));
    return url ? "Opened the apply page and the files" : "Opened the files";
  }
  if (a.action === "email_send") return sendEmailApproval(ctx, a, { root });
  throw new Error(`can't run "${a.action}" yet`);
}

/** The view, with `unsure` for an email send whose outcome isn't known (Mark as sent / Send again). */
function view(ctx: ServiceContext, root: string, a: Approval, mine = appApprovals(ctx, root)): ApprovalView {
  const v = approvalView(a, mine);
  return a.action === "email_send" && a.status === "approved" && sendState(root, a.id, ctx.now()) === "unknown" ? { ...v, unsure: true } : v;
}

/** One run per approval at a time in this process (the on-disk status and send journal cover other processes). */
async function exclusive<T>(ctx: ServiceContext, id: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = ctx.requireRoot();
  const key = `${root}\u0000${id}`;
  if (running.has(key)) throw new Error(`approval ${id} is already running`);
  running.add(key);
  try { return await fn(root); } finally { running.delete(key); }
}

/** Stored in the workspace and shown in the app, so it goes through the same scrubbing as any error (no absolute paths). */
const failNote = (e: unknown, root: string) => plainError(e, [root]).message.split("\n")[0]!.slice(0, 300);

/** An email send that may have gone: the approval stays "approved", noted, for Mark as sent or Send again. */
function keepUnsure(ctx: ServiceContext, root: string, a: Approval): void {
  setApprovalNote(root, a.id, UNSURE);
  logActivity(root, "Email may not have sent", a.title, ctx.clock());
}

export const CHANGED_SINCE_OPENED = "This request changed after you opened it. Review it again.";
export const CHANGED_SINCE_APPROVED = "This email changed since you approved it. Review and approve it again.";

const MAX_APPROVED = 200;

/** The digest the person approved for `id` in `root`, from app state outside the workspace. */
export function approvedDigest(ctx: ServiceContext, root: string, id: string): string | null {
  const v = ctx.host.state.read().approvedDigests?.[root]?.[id];
  return typeof v === "string" ? v : null;
}

/** Recorded when the person presses Approve, before anything runs. */
export function rememberApproved(ctx: ServiceContext, root: string, id: string, digest: string): void {
  const s = ctx.host.state.read();
  const here = Object.entries({ ...(s.approvedDigests?.[root] ?? {}), [id]: digest }).slice(-MAX_APPROVED);
  ctx.host.state.write({ ...s, approvedDigests: { ...s.approvedDigests, [root]: Object.fromEntries(here) } });
}

/** Runs the approval the person saw: `digest` is the one their card showed, and a changed record is refused before anything runs. */
async function approve(ctx: ServiceContext, id: string, digest: string): Promise<ApprovalView> {
  return exclusive(ctx, id, async (root) => {
    const a = readApproval(root, id);
    if (approvalDigest(a) !== digest) throw new Error(CHANGED_SINCE_OPENED);
    rememberApproved(ctx, root, id, digest);
    // Synchronous claim on disk: a second approve now fails with "is approved; it can't become approved".
    setApprovalStatus(root, id, "approved", "", ctx.clock());
    try {
      const note = await execute(ctx, a, root);
      setApprovalStatus(root, id, "done", note, ctx.clock());
      logActivity(root, "Approved", a.title, ctx.clock());
    } catch (e) {
      if (e instanceof SendUnsureError) keepUnsure(ctx, root, a);
      else {
        setApprovalStatus(root, id, "failed", failNote(e, root), ctx.clock());
        logActivity(root, "Approval failed", a.title, ctx.clock());
      }
    }
    return view(ctx, root, readApproval(root, id));
  });
}

/**
 * Send again, for an email send whose outcome is unknown. `digest` is the one the confirm dialog showed, and it must
 * also match the digest recorded when the person approved it. `confirm` must be true: the UI asks first,
 * since the person may get the message twice. A refusal before anything leaves (the draft changed,
 * the hourly limit) changes nothing; Gmail refusing it fails the approval.
 */
async function sendAgain(ctx: ServiceContext, id: string, digest: string, confirm: boolean): Promise<ApprovalView> {
  if (confirm !== true) throw new Error(CONFIRM_AGAIN);
  return exclusive(ctx, id, async (root) => {
    const a = readApproval(root, id);
    // Bound twice: to the preview the person just confirmed, and to what they approved (kept outside the workspace).
    const now = approvalDigest(a);
    if (now !== digest || approvedDigest(ctx, root, id) !== now) throw new Error(CHANGED_SINCE_APPROVED);
    if (a.action !== "email_send" || a.status !== "approved" || sendState(root, id, ctx.now()) !== "unknown") throw new Error(NOT_WAITING);
    try {
      const note = await sendEmailApproval(ctx, a, { again: true, root });
      setApprovalStatus(root, id, "done", note, ctx.clock());
      logActivity(root, "Sent again", a.title, ctx.clock());
    } catch (e) {
      if (e instanceof FoundInSentError) { /* closed as sent under the send lock; nothing went out */ }
      else if (e instanceof SendUnsureError) keepUnsure(ctx, root, a);
      else if (e instanceof SendRefusedError) {
        setApprovalStatus(root, id, "failed", failNote(e, root), ctx.clock());
        logActivity(root, "Approval failed", a.title, ctx.clock());
      } else throw e;
    }
    return view(ctx, root, readApproval(root, id));
  });
}

async function markAsSent(ctx: ServiceContext, id: string): Promise<ApprovalView> {
  return exclusive(ctx, id, async (root) => view(ctx, root, markSent(root, readApproval(root, id), ctx.now(), ctx.clock())));
}

function decline(ctx: ServiceContext, id: string, note: string): ApprovalView {
  const root = ctx.requireRoot();
  const a = setApprovalStatus(root, id, "declined", note, ctx.clock());
  logActivity(root, "Declined", a.title, ctx.clock());
  return view(ctx, root, a);
}

export const approvalHandlers = {
  "approvals.list": (ctx: ServiceContext) => {
    const root = ctx.requireRoot();
    const mine = appApprovals(ctx, root);
    return listApprovals(root).map((a) => withEmail(root, view(ctx, root, a, mine), ctx.clock()));
  },
  "approvals.approve": approve,
  "approvals.decline": decline,
} satisfies Partial<HandlerTable>;

/** Actions on an email send whose outcome is unknown. */
export const mailSendHandlers = {
  "mail.send.markSent": markAsSent,
  "mail.send.again": sendAgain,
} satisfies Partial<HandlerTable>;
