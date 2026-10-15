import { layout, proposeEmailSend, samplePdf, updateRecord, writeDraft } from "@careeros/core";
import { parseMessage, rawMessage, storeMessage, updateStored, type StoreTarget } from "@careeros/mail";
import { exampleAddress as at, jobKey, type ExampleClock, type ExampleIds } from "./sample-shared.js";

/**
 * The example's mail: recruiter outreach, interview invites, a rejection, an offer and a draft, stored the way a Gmail
 * sync stores them (copy, text, sidecar, a timeline event on the job). Gmail is never connected in the example, so
 * nothing here was fetched and nothing can be sent. Every name and address is made up (reserved example domains).
 */
interface ExampleMail {
  /** "<slug>/<title>" of the job it is filed under, or "triage" for Mail to sort. */
  job: string; id: string; ago: number; hour: number; minute?: number;
  dir: "in" | "out"; from: [string, string]; to?: [string, string]; subject: string; text: string;
  /** The id (local part) of the message this one answers. */
  reply?: string; read?: boolean; attach?: { name: string; type: string; content: Buffer }[];
}

const ALEX: [string, string] = ["Alex Example", at("alex")];
const SIGN = "\n\nRegards,\nAlex Example\nSenior AI Engineer | 0491 570 006";

const OFFER_PDF = Buffer.from(samplePdf([
  "Contoso AI: offer of employment", "Role: Applied AI Engineer", "Base salary: $158,000 plus super",
  "Visa: Contoso AI sponsors the skilled worker visa and pays the fees", "Start: once the visa is granted",
]));

const MAIL: ExampleMail[] = [
  {
    job: jobKey("acme-recruiting", "AI Developer"), id: "acme-recruiting-1", ago: 3, hour: 11, minute: 5, dir: "in", read: true,
    from: ["Jordan Lee", at("jordan.lee")], subject: "AI Developer contract with a government client",
    text: "Hi Alex,\n\nI came across your profile and think you'd suit a 6-month AI Developer contract with one of our government clients. It's a chatbot over policy documents, Python and an LLM API.\n\nAre you free for a quick call this week?\n\nThanks,\nJordan Lee\nSenior Consultant, Acme Recruiting\n0491 570 156",
  },
  {
    job: jobKey("acme-recruiting", "AI Developer"), id: "acme-recruiting-2", ago: 3, hour: 12, minute: 20, dir: "out", reply: "acme-recruiting-1",
    from: ALEX, to: ["Jordan Lee", at("jordan.lee")], subject: "Re: AI Developer contract with a government client",
    text: `Hi Jordan,\n\nThanks for thinking of me. The work sounds like a good fit.\n\nOne thing first: I'm on a temporary graduate visa and would need sponsorship for a permanent role. Can this client work with that?${SIGN}`,
  },
  {
    job: jobKey("acme-recruiting", "AI Developer"), id: "acme-recruiting-3", ago: 2, hour: 8, minute: 50, dir: "in", reply: "acme-recruiting-2", read: true,
    from: ["Jordan Lee", at("jordan.lee")], subject: "Re: AI Developer contract with a government client",
    text: "Hi Alex,\n\nThanks for being upfront. Unfortunately this client needs Australian citizens or permanent residents, because of a security check.\n\nI'll keep you in mind for private sector roles that can sponsor.\n\nJordan",
  },
  {
    job: jobKey("brightwater-analytics", "Machine Learning Engineer"), id: "brightwater-1", ago: 7, hour: 15, dir: "in", read: true,
    from: ["Morgan Reid", at("morgan.reid")], subject: "Interview invitation: Machine Learning Engineer",
    text: "Hi Alex,\n\nThanks for applying to Brightwater Analytics. We'd like to invite you to a first interview with our engineering lead.\n\nIt's 45 minutes on video. Could you do Thursday at 10 am or Friday at 2 pm?\n\nKind regards,\nMorgan Reid\nTalent Partner, Brightwater Analytics",
  },
  {
    job: jobKey("brightwater-analytics", "Machine Learning Engineer"), id: "brightwater-2", ago: 6, hour: 9, minute: 30, dir: "out", reply: "brightwater-1",
    from: ALEX, to: ["Morgan Reid", at("morgan.reid")], subject: "Re: Interview invitation: Machine Learning Engineer",
    text: `Hi Morgan,\n\nThank you. Thursday at 10 am works well for me.\n\nIs there anything I should prepare?${SIGN}`,
  },
  {
    job: jobKey("brightwater-analytics", "Machine Learning Engineer"), id: "brightwater-3", ago: 6, hour: 11, dir: "in", reply: "brightwater-2", read: true,
    from: ["Morgan Reid", at("morgan.reid")], subject: "Re: Interview invitation: Machine Learning Engineer",
    text: "Hi Alex,\n\nGreat, you're booked for Thursday at 10 am. The video link is in the calendar invite.\n\nNo preparation needed. Come ready to talk about a model you put into production and how you knew it was working.\n\nMorgan",
  },
  {
    job: jobKey("example-labs", "Backend Engineer (LLM)"), id: "example-labs-1", ago: 1, hour: 8, minute: 40, dir: "in",
    from: ["Casey Park", at("talent", "example.org")], subject: "Next step: technical interview for Backend Engineer (LLM)",
    text: "Hi Alex,\n\nThanks for your application. The team enjoyed reading about your retrieval API work.\n\nWe'd like to invite you to a 60-minute technical interview with two engineers. Expect a system design question about ingestion and search.\n\nPlease pick a time that suits you from the scheduling link in our next email.\n\nBest,\nCasey Park\nPeople Team, Example Labs",
  },
  {
    job: jobKey("acme-corp", "AI Engineer"), id: "acme-corp-1", ago: 2, hour: 9, minute: 5, dir: "in", read: true,
    from: ["Acme Corp Careers", at("careers")], subject: "We received your application: AI Engineer",
    text: "Hi Alex,\n\nThanks for applying for the AI Engineer role at Acme Corp. We review every application and will be in touch within two weeks.\n\nAcme Corp Talent Team",
  },
  {
    job: jobKey("northwind-analytics", "AI Platform Engineer"), id: "northwind-1", ago: 8, hour: 14, dir: "in", read: true,
    from: ["Northwind Analytics Recruiting", at("jobs", "example.net")], subject: "Your application for AI Platform Engineer",
    text: "Hi Alex,\n\nThank you for your interest in Northwind Analytics and for the time you put into your application.\n\nWe've decided to move forward with candidates who have more production Kubernetes experience. We'd be glad to see your name again for future roles.\n\nAll the best,\nNorthwind Analytics Recruiting",
  },
  {
    job: jobKey("contoso-ai", "Applied AI Engineer"), id: "contoso-1", ago: 13, hour: 16, dir: "in", read: true,
    from: ["Avery Brooks", at("avery.brooks")], subject: "Interview: Applied AI Engineer at Contoso AI",
    text: "Hi Alex,\n\nWe loved your application. Could you meet our hiring manager next Tuesday? After that there's a short technical interview and a take-home task.\n\nCheers,\nAvery Brooks\nHead of Talent, Contoso AI",
  },
  {
    job: jobKey("contoso-ai", "Applied AI Engineer"), id: "contoso-2", ago: 1, hour: 16, minute: 30, dir: "in",
    from: ["Avery Brooks", at("avery.brooks")], subject: "Your offer: Applied AI Engineer",
    text: "Hi Alex,\n\nCongratulations! We're delighted to offer you the Applied AI Engineer role at Contoso AI.\n\nThe written offer is attached. It includes the base salary, super and our sponsorship of your skilled worker visa, with Contoso AI paying the fees.\n\nTake a few days to read it, and call me with any questions.\n\nWarm regards,\nAvery Brooks\nHead of Talent, Contoso AI\n0491 570 159",
    attach: [{ name: "contoso-ai-offer-letter.pdf", type: "application/pdf", content: OFFER_PDF }],
  },
  {
    job: jobKey("fabrikam-health", "LLM Engineer"), id: "fabrikam-1", ago: 15, hour: 9, dir: "out",
    from: ALEX, to: ["Sam Rivera", at("hiring")], subject: "Application: LLM Engineer",
    text: `Hi Sam,\n\nPlease find my application for the LLM Engineer role. I build LLM features with evaluation and human review, which matches how you measure note accuracy with clinicians.\n\nMy resume is on the job page. I'd be glad to talk.${SIGN}`,
  },
  {
    job: "triage", id: "alert-1", ago: 0, hour: 6, minute: 45, dir: "in",
    from: ["Example Jobs Alerts", at("alerts", "example.net")], subject: "5 new AI Engineer jobs near Sampletown",
    text: "New jobs matching \"AI Engineer\" near Sampletown NSW:\n\n- AI Engineer, Wingtip Labs\n- LLM Engineer, Tailspin Software\n- Machine Learning Engineer, Lucerne Data\n- AI Developer, Margie's Travel Tech\n- Applied Scientist, Proseware\n\nManage your alerts at example.net.",
  },
  {
    job: "triage", id: "recruiter-2", ago: 2, hour: 17, dir: "in", read: true,
    from: ["Taylor Quinn", at("taylor.quinn", "example.org")], subject: "Quick question about your next move",
    text: "Hi Alex,\n\nI'm a recruiter working with a few AI start-ups in Sampletown. Are you open to a chat about roles that can sponsor?\n\nTaylor Quinn",
  },
];

/** RFC 5322 date for a message header. */
const headerDate = (d: Date) => d.toUTCString().replace("GMT", "+0000");

export async function seedExampleMail(root: string, ids: ExampleIds, k: ExampleClock): Promise<void> {
  const L = layout(root);
  const msgId = (id: string) => `<${id}${"@"}example.com>`;
  for (const m of MAIL) {
    const when = k.at(m.ago, m.hour, m.minute ?? 0);
    const ref = m.job === "triage" ? null : ids.get(m.job);
    if (m.job !== "triage" && !ref) continue;
    const to = m.to ?? ALEX;
    const raw = rawMessage({
      from: m.from[1], fromName: m.from[0], to: to[1], subject: m.subject, date: headerDate(when), text: m.text.replace(/\n/g, "\r\n"),
      extraHeaders: [`Message-ID: ${msgId(m.id)}`, ...(m.reply ? [`In-Reply-To: ${msgId(m.reply)}`, `References: ${msgId(m.reply)}`] : [])],
      id: null, attachments: m.attach,
    });
    const parsed = await parseMessage(raw);
    const target: StoreTarget = ref ? { company_slug: ref.slug, job_id: ref.id } : "triage";
    const header = {
      uid: 0, size: raw.length, internalDate: when.toISOString(), messageId: parsed.message_id, from: [{ name: m.from[0], address: m.from[1] }],
      to: [{ name: to[0], address: to[1] }], cc: [], subject: m.subject,
    };
    const stored = storeMessage(root, target, {
      raw, parsed, header, mailbox: m.dir === "in" ? "INBOX" : "Sent", direction: m.dir, matched_by: ref ? "recruiter" : "none", tooLarge: false,
    }, { now: when });
    if (m.dir === "in" && m.read) updateStored(root, stored.ref, (e) => { e.opened_at = new Date(when.getTime() + 20 * 60_000).toISOString(); });
    if (ref) {
      updateRecord("job", L.jobFile(ref.slug, ref.id), (j) => {
        j.timeline.push({ at: when.toISOString(), event: m.dir === "in" ? "Email received" : "Email sent", note: m.subject, message_id: parsed.message_id });
      });
    }
  }
  // A follow-up Claude drafted for Acme Corp, waiting for Alex to approve the exact email.
  const acme = ids.get(jobKey("acme-corp", "AI Engineer"));
  if (acme) {
    const draft = writeDraft(root, acme.slug, acme.id, {
      to: [{ name: "Riley Chen", address: at("careers") }], cc: [], subject: "Following up: AI Engineer application", attach: [], in_reply_to: msgId("acme-corp-1"),
      references: [msgId("acme-corp-1")], purpose: "",
      body: "Hi Riley,\n\nI applied for the AI Engineer role last week and wanted to say how much the clinic assistant interests me. I lead the evaluation suite for our support assistant at Sampletown Software, which checks every answer against its sources before release.\n\nI'd welcome a chance to talk about how I could help your team.\n\nRegards,\nAlex",
    }, undefined, k.c(0, 8, 10));
    proposeEmailSend(root, acme.slug, acme.id, draft.draft_id, "claude", k.c(0, 8, 15));
  }
  // Kestrel: a draft Alex started and hasn't finished.
  const kestrel = ids.get(jobKey("kestrel-robotics", "Conversational AI Developer"));
  if (kestrel) {
    writeDraft(root, kestrel.slug, kestrel.id, {
      to: [], cc: [], subject: "Question about the Conversational AI Developer role", attach: [], in_reply_to: "", references: [], purpose: "",
      body: "Hi,\n\nBefore I apply, could you tell me which speech APIs the team uses today?\n\n",
    }, undefined, k.c(0, 9, 40));
  }
}
