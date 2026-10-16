import {
  mailUrlFor, parseDraftSuggestion, SUGGESTION_UNREADABLE, type ApprovalView, type DraftAssist, type BackgroundStatus, type CareerosBridge, type ChangeArea, type DraftDetail, type DraftInput, type DraftView,
  type EmailPreview, type MailAddressView, type MailList, type MailMessageView, type MailNextUp, type MailQuery, type MailRow, type MailStatus,
  type MailTarget, type MailTestResult, type RecheckItem, type RecheckPreview, type RecheckResult, type TriageItem,
} from "@careeros/contract";
import { PRODUCT_NAME } from "@careeros/brand/identity";
import type { OutreachDraft, OutreachReply } from "@careeros/contract";
import type { ApprovalRecord } from "./fixture-types";

/** The only app password the mock accepts (16 letters, like Google's). Fictional. */
export const MOCK_GOOD_PASSWORD = "abcdefghijklmnop";
const at = (user: string, domain: string) => user + "@" + domain;
const ALEX = at("alex", "example.com");
const TALENT = at("talent", "example.org");
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/;
const ACME = { slug: "acme-corp", id: "2026-01-12-ai-engineer", company: "Acme Corp", title: "AI Engineer" };
const LABS = { slug: "example-labs", id: "2026-01-12-backend-engineer-llm", company: "Example Labs", title: "Backend Engineer (LLM)" };
// Same words as the services (mail-send.ts), so screens show what the real app shows.
const UNSURE = "Not sure it sent. Check Gmail's Sent folder.";
const NOT_WAITING = "This email isn't waiting for a check.";
const CONFIRM_AGAIN = "Confirm that you want to send this email again.";
const CHANGED_SINCE_APPROVED = "This email changed since you approved it. Review and approve it again.";
const ME_NOT_ATTACHABLE = "Files from your private me/ folder can't be attached to an email. If you want to send one, copy it into this job's folder first, then attach it from there.";
const NOT_FOUND = "This email can't be found. It may have been moved or deleted.";

export interface MockMailHooks {
  /** MockBridge.rec: records `args` and validates `validateAs` (the real arguments) with the contract. */
  rec<T>(method: string, args: unknown[], fn: () => T, validateAs?: unknown[]): Promise<T>;
  emit(...areas: ChangeArea[]): void;
  now(): string;
  jobName(slug: string, id: string): { company: string; title: string; apply_via: string };
  event(slug: string, id: string, event: string, note: string): void;
  /** The approval as the bridge shows it (digest and "From you"). */
  view(a: ApprovalRecord): ApprovalView;
  /** Records an approval this app created, so its card says "From you". */
  remember(a: ApprovalRecord): void;
  connected: boolean;
  /** Whether secure storage works on this (mock) computer. */
  secureStorage(): boolean;
  /** Approving an email send ends "not sure" (no final reply from Gmail), for Mark as sent and Send again. */
  sendUnsure: boolean;
  /** A workspace with no stored mail yet (a new one from the switcher). Default false. */
  empty?: boolean;
  /** `?maildemo`: more fictional mail for previewing the Mail screen. Default false. */
  demo?: boolean;
  /** A workspace file's text and when it was written (Claude's suggested email), or null. */
  file?(rel: string): { text: string; at: string } | null;
  /** The company record's recruiter, if it has one. */
  recruiter?(slug: string): { name: string; email: string } | null;
  /** The open workspace is the example: its made-up mail shows without Gmail. Default false. */
  example?: () => boolean;
  /** Link recruiter: records the address or domain on the agency, or throws when there is no such agency. */
  linkAgency?: (slug: string, value: string) => { name: string };
}
export interface MockMail {
  api: CareerosBridge["mail"];
  /** The approvals this mock created; MockBridge lists them with its own. */
  readonly approvals: ApprovalRecord[];
  nextUp(): MailNextUp;
  /** Emails filed under each company: how many, and the newest date. */
  companyStats(): { company_slug: string; count: number; last: string }[];
  withEmail(a: ApprovalView): ApprovalView;
  /** Runs an approved email send. Returns the result note, or null when the send ended "not sure". */
  sendApproved(a: ApprovalRecord): string | null;
  applyEmail(slug: string, id: string): string;
  /** secrets.set("gmail_app_password") as the services do it: test against the connected address, keep the old one on failure. */
  replacePassword(value: string): void;
  /** Whether this workspace's (mock) Gmail is connected right now. */
  isConnected(): boolean;
  /** A saved draft of this job (for main's draft_email mapping), or null. */
  draftFor(slug: string, id: string, draftId: string): { input: DraftInput; sent: boolean } | null;
  /** Whether an email with this Message-ID is filed under this job. */
  hasMessage(slug: string, id: string, messageId: string): boolean;
  /** Drafts and received mail, for the Recruiters timeline and reply detection. */
  outreach(): { drafts: OutreachDraft[]; replies: OutreachReply[] };
  /** Every filed message (mail out with its first recipient) and every draft, for a recruiter's Emails tab. */
  everything(): { rows: (MailRow & { to?: MailAddressView[] })[]; drafts: DraftView[] };
}

/** Free-mail domains the mock knows (the services use the mail module's full list). */
const MOCK_FREE_MAIL = /(^|\.)(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|aol|bigpond)\.(com|me)(\.[a-z]{2})?$/i;

interface Msg { view: MailMessageView; snippet: string; /** `?maildemo`: what "Re-check filed mail" would do with it. */ recheck?: "sort" | "unfile" }
interface Draft { draft_id: string; slug: string; id: string; input: DraftInput; status: DraftView["status"]; updated: string; approval_id: string; note: string }
type MailApproval = ApprovalRecord & { unsure?: boolean };

const refFor = (slug: string, id: string, base: string) => `companies/${slug}/${id ? `jobs/${id}/` : ""}emails/${base}.json`;

function message(o: {
  base: string; job: typeof ACME; direction?: "in" | "out"; from: MailAddressView; subject: string; date: string; auth?: "pass" | "fail" | "none";
  warnings?: string[]; remote?: number; attachments?: MailMessageView["attachments"]; opened?: string; snippet?: string;
}): Msg {
  return {
    snippet: o.snippet ?? "",
    view: {
      ref: refFor(o.job.slug, o.job.id, o.base), company_slug: o.job.slug, company_name: o.job.company, job_id: o.job.id, job_title: o.job.title,
      triage: false, direction: o.direction ?? "in", from: o.from, to: [{ name: "Alex Example", address: ALEX }], cc: [], reply_to: [],
      subject: o.subject, date: o.date, message_id: `<${o.base}@example.org>`, references: [], thread_key: `<${o.base}@example.org>`,
      auth: o.auth ?? "pass", warnings: o.warnings ?? [], images_allowed: false, remote_images: o.remote ?? 0, too_large: false, has_raw: true,
      attachments: o.attachments ?? [], opened_at: o.opened ?? "",
    },
  };
}

/** `?maildemo` only: more fictional mail, so the list's density and the reader can be previewed. */
function demoMessages(): Msg[] {
  const person = (name: string, user: string, domain: string) => ({ name, address: at(user, domain) });
  return [
    message({ base: "2026-01-15-your-application-at-example-labs-b1b2b3", job: LABS, from: person("Example Labs Careers", "careers", "examplelabs.example.net"), subject: "Your application for Backend Engineer (LLM) at Example Labs", date: "2026-01-15T02:30:00.000Z", remote: 2, snippet: "Thanks for applying. Here's what happens next, and when you can expect to hear from us." }),
    message({ base: "2026-01-11-coffee-chat-c1c2c3", job: { ...ACME, id: "", title: "" }, from: person("Jordan Lee", "jordan.lee", "acme.example.com"), subject: "Coffee chat about the AI team?", date: "2026-01-11T23:10:00.000Z", opened: "2026-01-12T01:00:00.000Z", snippet: "Hi Alex, a colleague passed on your profile. Would you be up for a 20 minute chat next week?" }),
    message({ base: "2026-01-10-take-home-task-d1d2d3", job: ACME, from: person("Acme Talent", "talent", "example.org"), subject: "Take-home task: retrieval evaluation", date: "2026-01-10T04:00:00.000Z", opened: "2026-01-10T05:00:00.000Z", snippet: "Please find the take-home task below. It should take about three hours. There's no hard deadline.",
      attachments: [{ part: "2", name: "Retrieval evaluation brief with a deliberately long file name.pdf", size: 240_000, type: "application/pdf", inline: false, saved_rel: "", risky: false }] }),
    { ...message({ base: "2026-01-07-review-your-acme-account-settings-f1f2f3", job: ACME, from: person("Acme Accounts", "noreply-accounts", "acme.example.com"), subject: "Review your Acme Account settings", date: "2026-01-07T01:00:00.000Z", opened: "2026-01-07T02:00:00.000Z", snippet: "You recently shared some Acme Account data with Example Labs. Review your settings." }), recheck: "unfile" },
    { ...message({ base: "2026-01-06-welcome-to-the-job-board-a9a8a7", job: ACME, from: person("Job board", "noreply", "jobs.example.net"), subject: "Welcome to the job board", date: "2026-01-06T01:00:00.000Z", opened: "2026-01-06T02:00:00.000Z", snippet: "Thanks for signing up. Set up job alerts to hear about new roles first." }), recheck: "sort" },
    message({ base: "2026-01-08-thanks-for-your-time-e1e2e3", job: LABS, from: person("Sam Sample", "sam", "examplelabs.example.net"), subject: "Thanks for your time today", date: "2026-01-08T06:45:00.000Z", opened: "2026-01-08T07:00:00.000Z", snippet: "It was great to meet you. I'll share feedback from the panel by Friday." }),
  ];
}

function seed(demo = false): { messages: Msg[]; triage: TriageItem[]; drafts: Draft[] } {
  const spoofFrom = at("x", "evil.example.net");
  return {
    messages: [
      ...(demo ? demoMessages() : []),
      message({
        base: "2026-01-14-interview-for-ai-engineer-a1b2c3", job: ACME, from: { name: "Acme Talent", address: TALENT }, subject: "Interview for AI Engineer",
        date: "2026-01-14T09:00:00.000Z", remote: 1, snippet: "Hi Alex, thanks for applying. Could you talk on Friday at 10 am? The details are attached.",
        attachments: [
          { part: "2", name: "Interview details.pdf", size: 18_000, type: "application/pdf", inline: false, saved_rel: "", risky: false },
          { part: "3", name: "setup.exe", size: 2, type: "application/octet-stream", inline: false, saved_rel: "", risky: true },
        ],
      }),
      message({
        base: "2026-01-13-urgent-confirm-your-details-d4e5f6", job: LABS, from: { name: `Example Labs (${at("talent", "examplelabs.example.net")})`, address: spoofFrom },
        subject: "Urgent: confirm your details", date: "2026-01-13T09:00:00.000Z", auth: "fail", snippet: "Your account will be closed today unless you confirm your bank details at the link below.",
        warnings: [
          "Gmail couldn't confirm this email really came from evil.example.net. Be careful with its links and attachments.",
          `The sender's name shows examplelabs.example.net, but the email came from ${spoofFrom}.`,
        ],
      }),
      message({
        base: "2026-01-12-re-ai-engineer-application-0a0b0c", job: ACME, direction: "out", from: { name: "Alex Example", address: ALEX },
        subject: "Re: AI Engineer application", date: "2026-01-12T10:00:00.000Z", opened: "2026-01-12T10:00:00.000Z", snippet: "Thanks, I've attached my resume and a short cover letter.",
      }),
    ],
    triage: [
      { id: "2026-01-14-your-application-e1e2e3", ref: ".careeros/mail-triage/2026-01-14-your-application-e1e2e3.json", from: { name: "Example Labs People", address: at("people", "examplelabs-mail.example.org") }, subject: "Your application", date: "2026-01-14T08:00:00.000Z", suggestion: { company_slug: LABS.slug, company_name: LABS.company, reason: "The subject names Example Labs." } },
      { id: "2026-01-14-new-jobs-for-you-f1f2f3", ref: ".careeros/mail-triage/2026-01-14-new-jobs-for-you-f1f2f3.json", from: { name: "Job alerts", address: at("alerts", "jobs.example.net") }, subject: "New jobs for you", date: "2026-01-14T07:00:00.000Z", suggestion: null },
    ],
    drafts: [{
      draft_id: "20260114t120000-aaaaaa", slug: LABS.slug, id: LABS.id, status: "draft", updated: "2026-01-14T12:00:00.000Z", approval_id: "", note: "",
      input: { to: at("hiring", "examplelabs.example.net"), cc: "", subject: "Following up", body: "Hi,\n\nI wanted to follow up on my application.\n\nRegards,\nAlex", attach: [], in_reply_to: "", references: [], purpose: "" },
    }],
  };
}

function parseList(s: string): MailAddressView[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*)<([^>]+)>$/);
    const name = m ? m[1]!.trim().replace(/^"|"$/g, "") : "";
    const address = (m ? m[2]! : x).trim();
    if (!EMAIL.test(address)) throw new Error(`"${address.slice(0, 80)}" isn't an email address.`);
    return { name, address };
  });
}

/** A fictional Gmail account for the dev preview and tests: messages, sorting, drafts and sends, all in memory. No network. */
export function createMockMail(h: MockMailHooks): MockMail {
  const s = h.empty ? { messages: [], triage: [], drafts: [] } : seed(h.demo);
  // Only the demo has mail the old rules misfiled, so only it offers "Re-check filed mail" on its own.
  let recheckOffered = !h.demo;
  const recheckToken = () => s.messages.filter((m) => m.recheck).length.toString(16).padStart(64, "0");
  let connected = h.connected;
  let address = connected ? ALEX : "";
  let displayName = "Alex Example";
  let signature = "Alex Example\nAI Engineer";
  let staged = "";
  let lastSync = connected ? "2026-01-15T08:45:00.000Z" : "";
  let lastError = "";
  let background = { on: false, minutes: 60 };
  let seq = 0;
  const ignored: string[] = [];
  const approvals: MailApproval[] = [];

  const status = (): MailStatus => ({
    available: true, connected, address, display_name: displayName, signature, password_set: connected, secure_storage: h.secureStorage(), syncing: false,
    last_sync: lastSync, last_ok: lastSync, next_sync: connected ? "2026-01-15T09:15:00.000Z" : "", last_error: lastError,
    counts: { stored: 2, triaged: 2, skipped: 14, duplicates: 0, too_large: 0 }, purged: 0, sync_minutes: 15, first_sync_days: 30,
    send_limit_per_hour: 10, cloud_folder: "", raw_bytes: s.messages.filter((m) => m.view.has_raw).length * 24_000, triage_count: triageLeft().length,
    example: h.example?.() ?? false,
  });
  const row = (v: MailMessageView): MailRow => ({
    ref: v.ref, company_slug: v.company_slug, company_name: v.company_name, job_id: v.job_id, job_title: v.job_title, direction: v.direction,
    date: v.date, subject: v.subject, from: v.from, thread_key: v.thread_key, attachments: v.attachments.length, opened: !!v.opened_at, matched_by: "recruiter",
    snippet: s.messages.find((m) => m.view.ref === v.ref)?.snippet ?? "",
  });
  const find = (ref: string): Msg => {
    const m = s.messages.find((x) => x.view.ref === ref);
    if (!m) throw new Error(NOT_FOUND);
    return m;
  };
  const rows = () => s.messages.map((m) => row(m.view)).sort((a, b) => b.date.localeCompare(a.date));
  const list = (q: MailQuery): MailList => {
    const t = q.text?.toLowerCase();
    const r = rows().filter((x) => (!q.company_slug || x.company_slug === q.company_slug) && (!q.id || x.job_id === q.id || (!!q.includeCompany && !x.job_id))
      && (!q.direction || x.direction === q.direction) && (!q.unread || (!x.opened && x.direction === "in")) && (!q.attachments || x.attachments > 0)
      && (!t || [x.subject, x.from.name, x.from.address, x.company_name].some((y) => y.toLowerCase().includes(t))));
    return { rows: r.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200)), total: r.length };
  };
  const draftView = (d: Draft): DraftView => {
    const j = h.jobName(d.slug, d.id);
    // A declined or failed send frees the draft again, like the services.
    const a = d.status === "waiting" ? approvals.find((x) => x.id === d.approval_id) : undefined;
    if (a && (a.status === "declined" || a.status === "failed")) { d.status = a.status === "failed" ? "failed" : "draft"; d.note = a.status === "failed" ? a.result_note : ""; }
    return {
      draft_id: d.draft_id, company_slug: d.slug, id: d.id, company_name: j.company, job_title: j.title, rel: d.id ? `companies/${d.slug}/jobs/${d.id}/emails/drafts/${d.draft_id}.md` : `companies/${d.slug}/emails/drafts/${d.draft_id}.md`,
      subject: d.input.subject, to: d.input.to, status: d.status, updated: d.updated, approval_id: d.approval_id, note: d.note,
    };
  };
  const findDraft = (slug: string, id: string, draftId: string): Draft => {
    const d = s.drafts.find((x) => x.slug === slug && x.id === id && x.draft_id === draftId);
    if (!d) throw new Error(`The draft ${draftId} can't be found.`);
    return d;
  };
  const preview = (d: Draft, current = true): EmailPreview => {
    const j = h.jobName(d.slug, d.id);
    const sig = signature.trim();
    const body = d.input.body.replace(/\s+$/, "");
    return {
      account: address, from: { name: displayName, address }, to: parseList(d.input.to), cc: parseList(d.input.cc), subject: d.input.subject,
      text: sig ? `${body}\n\n${sig}\n` : `${body}\n`, in_reply_to: d.input.in_reply_to,
      attachments: d.input.attach.map((rel) => ({ rel, name: rel.split("/").pop() ?? rel, size: 2048, type: "application/pdf", locked: rel.startsWith("me/identity/") ? "me/identity" : null })),
      locked: d.input.attach.some((rel) => rel.startsWith("me/identity/")), current, problem: current ? "" : "The draft changed. Review it again.",
      job: { company_slug: d.slug, id: d.id, title: j.title, company_name: j.company },
    };
  };
  const detail = (d: Draft): DraftDetail => ({ view: draftView(d), draft: { ...d.input }, preview: d.status === "sent" ? null : preview(d) });
  const triageLeft = () => s.triage.filter((t) => !ignored.some((x) => t.from.address.toLowerCase() === x || t.from.address.toLowerCase().endsWith(`@${x}`)))
    .map((t) => ({ ...t, free_mail: MOCK_FREE_MAIL.test(t.from.address.slice(t.from.address.lastIndexOf("@") + 1)) }));
  const backgroundView = (): BackgroundStatus => ({ supported: true, on: background.on, minutes: background.minutes, installed: background.on, detail: background.on ? "Scheduled (mock)." : "Not scheduled.", log: [] });
  /** Same rule as the services' normalizePassword: four groups of four letters. True when it is the mock's good password. */
  const checkPassword = (password: string): boolean => {
    const t = password.trim();
    if (!/^[A-Za-z]{4}(?:[ \u00a0]?[A-Za-z]{4}){3}$/.test(t)) throw new Error("An app password is 16 letters. Copy it again from Google's App Passwords page.");
    return t.replace(/[ \u00a0]/g, "").toLowerCase() === MOCK_GOOD_PASSWORD;
  };
  const testResult = (ok: boolean): MailTestResult => {
    const fail = { ok: false, message: "Gmail didn't accept the address and app password.", fix: "Check the address, then create a new app password and paste all 16 letters." };
    return {
      ok,
      checks: ok
        ? [{ id: "imap", label: "Sign in to Gmail", ok: true, message: "Signed in to Gmail.", fix: "" }, { id: "sent", label: "Find the Sent folder", ok: true, message: "Found your Sent folder ([Gmail]/Sent Mail).", fix: "" }, { id: "smtp", label: "Sign in to send", ok: true, message: `Gmail will accept mail you send from ${PRODUCT_NAME}. Nothing was sent.`, fix: "" }]
        : [{ id: "imap", label: "Sign in to Gmail", ...fail }, { id: "sent", label: "Find the Sent folder", ok: false, message: "Not checked, because signing in failed.", fix: "" }, { id: "smtp", label: "Sign in to send", ...fail }],
    };
  };
  const requireConnected = () => { if (!connected) throw new Error("Connect Gmail in Settings > Email first."); };
  const viewOf = (a: MailApproval): ApprovalView => {
    const v = h.view(a);
    return a.unsure && a.status === "approved" ? { ...v, unsure: true } : v;
  };

  /** Stores the sent copy, marks the draft sent and adds "Email sent" to the job. */
  const deliver = (a: MailApproval): string => {
    const d = s.drafts.find((x) => x.approval_id === a.id);
    if (!d) throw new Error("The draft can't be found.");
    const p = preview(d);
    const j = h.jobName(d.slug, d.id);
    s.messages.push(message({ base: `${d.draft_id}-sent`, job: { slug: d.slug, id: d.id, company: j.company, title: j.title }, direction: "out", from: p.from, subject: p.subject, date: h.now(), opened: h.now() }));
    d.status = "sent"; d.note = "";
    if (d.id) h.event(d.slug, d.id, "Email sent", p.subject);
    const n = p.to.length + p.cc.length;
    return `Sent to ${n} recipient${n === 1 ? "" : "s"}`;
  };
  const waiting = (id: string): MailApproval => {
    const a = approvals.find((x) => x.id === id);
    if (!a || a.action !== "email_send" || a.status !== "approved" || !a.unsure) throw new Error(NOT_WAITING);
    return a;
  };
  const close = (a: MailApproval, note: string): ApprovalView => {
    Object.assign(a, { status: "done", result_note: note, unsure: false, decided_at: h.now() });
    h.emit("mail", "approvals", "jobs", "home");
    return viewOf(a);
  };

  const api: CareerosBridge["mail"] = {
    status: () => h.rec("mail.status", [], status),
    // The password is checked against the contract but recorded as "<redacted>", like secrets.set. It never comes back.
    testConnection: (addr: string, name: string, password: string) => h.rec("mail.testConnection", [addr, name, "<redacted>"], (): MailTestResult => {
      if (!EMAIL.test(addr.trim())) throw new Error(`"${addr.slice(0, 80)}" isn't an email address.`);
      const ok = checkPassword(password);
      staged = ok ? addr.trim().toLowerCase() : "";
      return testResult(ok);
    }, [addr, name, password]),
    saveAccount: (addr: string, name: string) => h.rec("mail.saveAccount", [addr, name], () => {
      if (!staged || staged !== addr.trim().toLowerCase()) throw new Error(`Test the connection first. ${PRODUCT_NAME} saves the account only after a passing test.`);
      staged = ""; connected = true; address = addr.trim(); displayName = name.trim(); lastError = "";
      h.emit("mail", "settings", "home");
      return status();
    }),
    disconnect: () => h.rec("mail.disconnect", [], () => { connected = false; address = ""; background = { ...background, on: false }; h.emit("mail", "settings", "home"); return status(); }),
    setSignature: (text: string) => h.rec("mail.setSignature", [text], () => { signature = text.replace(/\r\n?/g, "\n").replace(/\s+$/, ""); h.emit("mail", "settings"); return status(); }),
    syncNow: () => h.rec("mail.syncNow", [], () => { requireConnected(); lastSync = h.now(); h.emit("mail", "jobs", "home"); return status(); }),
    list: (q: MailQuery) => h.rec("mail.list", [q], () => list(q)),
    get: (ref: string) => h.rec("mail.get", [ref], () => {
      const m = find(ref);
      if (!m.view.opened_at && m.view.direction === "in") { m.view.opened_at = h.now(); h.emit("home"); }
      return m.view;
    }),
    loadImages: (ref: string) => h.rec("mail.loadImages", [ref], () => { const m = find(ref); m.view.images_allowed = true; h.emit("mail"); return m.view; }),
    saveAttachment: (ref: string, part: string) => h.rec("mail.saveAttachment", [ref, part], () => {
      const m = find(ref);
      const a = m.view.attachments.find((x) => x.part === part);
      if (!a) throw new Error("That attachment isn't in this email.");
      const dir = ref.slice(0, ref.lastIndexOf("/"));
      a.saved_rel = `${dir}/attachments/${a.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
      h.emit("mail", "jobs");
      return m.view;
    }),
    move: (ref: string, target: MailTarget) => h.rec("mail.move", [ref, target], () => {
      const m = find(ref);
      const j = h.jobName(target.company_slug, target.id ?? "");
      const base = ref.slice(ref.lastIndexOf("/") + 1, -5);
      Object.assign(m.view, { ref: refFor(target.company_slug, target.id ?? "", base), company_slug: target.company_slug, job_id: target.id ?? "", company_name: j.company, job_title: target.id ? j.title : "" });
      if (target.id) h.event(target.company_slug, target.id, "Email received", m.view.subject);
      h.emit("mail", "jobs", "home");
      return m.view;
    }),
    recheck: {
      preview: () => h.rec("mail.recheck.preview", [], (): RecheckPreview => {
        const items = s.messages.filter((m) => m.recheck).map((m): RecheckItem => ({
          ref: m.view.ref, subject: m.view.subject, from: m.view.from, date: m.view.date, company_name: m.view.company_name, job_title: m.view.job_title, outcome: m.recheck!,
        }));
        return { due: !recheckOffered, checked: s.messages.length, sort: items.filter((i) => i.outcome === "sort").length, unfile: items.filter((i) => i.outcome === "unfile").length, items, token: recheckToken() };
      }),
      apply: (token: string) => h.rec("mail.recheck.apply", [token], (): RecheckResult => {
        if (token !== recheckToken()) throw new Error("The filed mail changed since you looked. Check the list again, then confirm.");
        const out = { sorted: 0, unfiled: 0 };
        for (const m of s.messages.filter((x) => x.recheck)) {
          if (m.recheck === "sort") {
            const base = m.view.ref.slice(m.view.ref.lastIndexOf("/") + 1, -5);
            s.triage.push({ id: base, ref: `.careeros/mail-triage/${base}.json`, from: m.view.from, subject: m.view.subject, date: m.view.date, suggestion: null });
            out.sorted++;
          } else out.unfiled++;
        }
        s.messages = s.messages.filter((x) => !x.recheck);
        recheckOffered = true;
        h.emit("mail", "jobs", "home");
        return out;
      }),
      dismiss: () => h.rec("mail.recheck.dismiss", [], () => { recheckOffered = true; }),
    },
    prune: (months: number) => h.rec("mail.prune", [months], () => {
      const cutoff = new Date(new Date(h.now()).getTime() - months * 30 * 86_400_000).toISOString();
      const old = s.messages.filter((m) => m.view.has_raw && m.view.date < cutoff);
      for (const m of old) m.view.has_raw = false;
      h.emit("mail");
      return { removed: old.length, bytes: old.length * 24_000 };
    }),
    triage: {
      list: () => h.rec("mail.triage.list", [], triageLeft),
      assign: (id: string, target: MailTarget, addMatch: boolean) => h.rec("mail.triage.assign", [id, target, addMatch], () => {
        const i = s.triage.findIndex((t) => t.id === id);
        if (i < 0) throw new Error(NOT_FOUND);
        const [t] = s.triage.splice(i, 1);
        const j = h.jobName(target.company_slug, target.id ?? "");
        s.messages.push(message({ base: t!.id, job: { slug: target.company_slug, id: target.id ?? "", company: j.company, title: target.id ? j.title : "" }, from: t!.from, subject: t!.subject, date: t!.date }));
        if (target.id) h.event(target.company_slug, target.id, "Email received", t!.subject);
        h.emit("mail", "jobs", "home");
        return triageLeft();
      }),
      createCompany: (id: string, name: string, jobTitle: string) => h.rec("mail.triage.createCompany", [id, name, jobTitle], () => {
        const i = s.triage.findIndex((t) => t.id === id);
        if (i < 0) throw new Error(NOT_FOUND);
        s.triage.splice(i, 1);
        h.emit("mail", "jobs", "home", "sponsors");
        return triageLeft();
      }),
      ignore: (id: string, scope: "sender" | "domain") => h.rec("mail.triage.ignore", [id, scope], () => {
        const t = s.triage.find((x) => x.id === id);
        if (!t) throw new Error(NOT_FOUND);
        const a = t.from.address.toLowerCase();
        ignored.push(scope === "sender" ? a : a.slice(a.indexOf("@") + 1));
        s.triage = triageLeft();
        h.emit("mail");
        return triageLeft();
      }),
      linkAgency: (id: string, slug: string, scope: "address" | "domain") => h.rec("mail.triage.linkAgency", [id, slug, scope], () => {
        const t = s.triage.find((x) => x.id === id);
        if (!t) throw new Error(NOT_FOUND);
        const a = t.from.address.toLowerCase();
        const domain = a.slice(a.lastIndexOf("@") + 1);
        if (scope === "domain" && MOCK_FREE_MAIL.test(domain)) throw new Error(`${domain} is shared by many people, so only this exact address can be linked.`);
        const value = scope === "domain" ? domain : a;
        const agency = h.linkAgency ? h.linkAgency(slug, value) : { name: slug };
        // This message and every other waiting one from that sender (or domain) is filed under the agency.
        const mine = s.triage.filter((x) => (scope === "domain" ? x.from.address.toLowerCase().endsWith(`@${domain}`) : x.from.address.toLowerCase() === a));
        s.triage = s.triage.filter((x) => !mine.includes(x));
        for (const m of mine) s.messages.push(message({ base: m.id, job: { slug, id: "", company: agency.name, title: "" }, from: m.from, subject: m.subject, date: m.date }));
        h.emit("mail", "recruiters", "jobs");
        return triageLeft();
      }),
    },
    drafts: {
      all: () => h.rec("mail.drafts.all", [], () => s.drafts.map(draftView).sort((a, b) => b.updated.localeCompare(a.updated))),
      list: (slug: string, id: string) => h.rec("mail.drafts.list", [slug, id], () => s.drafts.filter((d) => d.slug === slug && d.id === id).map(draftView)),
      get: (slug: string, id: string, draftId: string) => h.rec("mail.drafts.get", [slug, id, draftId], () => detail(findDraft(slug, id, draftId))),
      save: (slug: string, id: string, draftId: string, input: DraftInput) => h.rec("mail.drafts.save", [slug, id, draftId, input], () => {
        parseList(input.to); parseList(input.cc);
        // Like core: attachments only ever come from this job's own folder.
        for (const rel of input.attach) {
          if (rel === "me" || rel.startsWith("me/")) throw new Error(ME_NOT_ATTACHABLE);
          const own = id ? `companies/${slug}/jobs/${id}/` : `companies/${slug}/`;
          if (!rel.startsWith(own)) throw new Error(`"${rel}" can't be attached. Attach a file from this ${id ? "job" : "company"}'s own folder.`);
        }
        if (draftId) {
          const d = findDraft(slug, id, draftId);
          if (d.status === "sent") throw new Error("This email was already sent. Start a new draft.");
          Object.assign(d, { input: { ...input }, updated: h.now() });
          h.emit("mail");
          return detail(d);
        }
        const d: Draft = { draft_id: `20260115t090000-mock${String(++seq).padStart(2, "0")}`, slug, id, input: { ...input }, status: "draft", updated: h.now(), approval_id: "", note: "" };
        s.drafts.push(d);
        h.emit("mail");
        return detail(d);
      }),
      assist: (slug: string, id: string) => h.rec("mail.drafts.assist", [slug, id], (): DraftAssist => {
        h.jobName(slug, id);
        const f = h.file?.(`companies/${slug}/jobs/${id}/emails/suggested/draft.json`) ?? null;
        let suggestion: DraftAssist["suggestion"] = null;
        let problem = "";
        if (f) { try { suggestion = { ...parseDraftSuggestion(f.text), at: f.at }; } catch { problem = SUGGESTION_UNREADABLE; } }
        const r = h.recruiter?.(slug) ?? null;
        const apply = h.jobName(slug, id).apply_via.trim().replace(/^mailto:/i, "").split("?")[0]!;
        const recipient = r && EMAIL.test(r.email) ? { name: r.name, address: r.email } : EMAIL.test(apply) ? { name: "", address: apply } : null;
        return { suggestion, problem, recipient };
      }),
      propose: (slug: string, id: string, draftId: string) => h.rec("mail.drafts.propose", [slug, id, draftId], () => {
        requireConnected();
        const d = findDraft(slug, id, draftId);
        const p = preview(d);
        const people = [...p.to, ...p.cc].map((x) => x.address);
        const a: MailApproval = {
          id: `20260115t090000-mail${String(++seq).padStart(2, "0")}`, action: "email_send", title: `Send "${d.input.subject}"`, summary: `To ${people.join(", ")}`,
          steps: [`Send one email from ${address} to ${people.length} recipient(s)`, "Save the sent copy in the job's emails folder", 'Add "Email sent" to the job timeline'],
          payload: { company_slug: slug, id, draft_id: draftId, purpose: d.input.purpose }, created_at: h.now(), created_by: "app", status: "pending", decided_at: "", result_note: "",
        };
        approvals.push(a);
        h.remember(a);
        d.status = "waiting"; d.approval_id = a.id;
        h.emit("mail", "approvals", "home");
        return { ...viewOf(a), email: p };
      }),
    },
    send: {
      markSent: (id: string) => h.rec("mail.send.markSent", [id], () => {
        const a = waiting(id);
        deliver(a);
        return close(a, "Marked as sent");
      }),
      again: (id: string, digest: string, confirm: boolean) => h.rec("mail.send.again", [id, digest, confirm], () => {
        if (confirm !== true) throw new Error(CONFIRM_AGAIN);
        const a = waiting(id);
        if (viewOf(a).digest !== digest) throw new Error(CHANGED_SINCE_APPROVED);
        return close(a, deliver(a));
      }),
    },
    background: {
      status: () => h.rec("mail.background.status", [], backgroundView),
      set: (on: boolean, minutes: number) => h.rec("mail.background.set", [on, minutes], () => { if (on) requireConnected(); background = { on, minutes }; h.emit("mail"); return backgroundView(); }),
    },
  };

  return {
    isConnected: () => connected,
    api,
    draftFor: (slug, id, draftId) => {
      const d = s.drafts.find((x) => x.slug === slug && x.id === id && x.draft_id === draftId);
      return d ? { input: { ...d.input }, sent: d.status === "sent" } : null;
    },
    hasMessage: (slug, id, messageId) => s.messages.some((m) => m.view.company_slug === slug && m.view.job_id === id && m.view.message_id === messageId),
    outreach: () => ({
      drafts: s.drafts.map(draftView).map((d) => ({ to: d.to, subject: d.subject, status: d.status, updated: d.updated })),
      replies: s.messages.filter((m) => m.view.direction === "in").map((m) => ({ from: m.view.from.address, date: m.view.date, subject: m.view.subject })),
    }),
    everything: () => ({
      rows: s.messages.map((m) => ({ ...row(m.view), ...(m.view.direction === "out" ? { to: m.view.to.slice(0, 1) } : {}) })),
      drafts: s.drafts.map(draftView),
    }),
    companyStats: () => {
      const by = new Map<string, { company_slug: string; count: number; last: string }>();
      for (const r of rows()) {
        if (!r.company_slug) continue;
        const x = by.get(r.company_slug) ?? { company_slug: r.company_slug, count: 0, last: "" };
        x.count++;
        if (r.date > x.last) x.last = r.date;
        by.set(r.company_slug, x);
      }
      return [...by.values()];
    },
    approvals,
    nextUp: () => {
      // Like the services: with Gmail not connected there is no unread count or reply to show.
      const unread = connected ? rows().filter((r) => r.direction === "in" && !r.opened) : [];
      return { unread: unread.slice(0, 10), unreadCount: unread.length, drafts: s.drafts.map(draftView) };
    },
    withEmail: (v) => {
      const a = approvals.find((x) => x.id === v.id);
      const out = a?.unsure && a.status === "approved" ? { ...v, unsure: true } : v;
      if (out.action !== "email_send" || (out.status !== "pending" && !out.unsure)) return out;
      const d = s.drafts.find((x) => x.approval_id === out.id);
      return d ? { ...out, email: preview(d) } : out;
    },
    sendApproved: (a) => {
      const m = approvals.find((x) => x.id === a.id);
      if (!m) throw new Error("The draft can't be found.");
      if (h.sendUnsure) {
        m.unsure = true;
        m.result_note = UNSURE;
        const d = s.drafts.find((x) => x.approval_id === a.id);
        if (d) { d.status = "unsure"; d.note = UNSURE; }
        return null;
      }
      return deliver(m);
    },
    applyEmail: (slug, id) => {
      const v = h.jobName(slug, id).apply_via.trim().replace(/^mailto:/i, "").split("?")[0]!;
      return EMAIL.test(v) ? v : "";
    },
    replacePassword: (value) => {
      requireConnected();
      if (!checkPassword(value)) throw new Error(`The new password didn't work: ${testResult(false).checks.find((c) => !c.ok)!.message}`);
      lastError = "";
      h.emit("mail", "settings");
    },
  };
}

/** The careeros-mail: URL the real preload builds; the mock has no frame server, so this is only for display and tests. */
export const mockMailUrl = (ref: string): string => mailUrlFor(ref);
