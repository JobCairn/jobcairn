import type { DraftInput } from "@careeros/contract";

/**
 * A fictional draft_email result for the mock (Alex Example writing to Acme Corp): what Claude would write to
 * draft.json for the chosen purpose, or the current draft reworked. Never real data.
 */
export function mockEmailDraft(o: { purpose: string; mode: string; title: string; company: string; current: DraftInput | null }): { subject: string; body: string } {
  const role = o.title || "AI Engineer";
  const company = o.company || "Acme Corp";
  const cur = o.current;
  if (o.mode !== "new" && cur?.body.trim()) {
    const subject = cur.subject.trim() || `${role} role`;
    const lines = cur.body.trim().split(/\n{2,}/);
    switch (o.mode) {
      case "shorter": return { subject, body: [lines[0], lines.slice(1, -1).join(" ").split(/(?<=\.)\s/)[0], lines.at(-1)].filter(Boolean).join("\n\n") };
      case "warmer": return { subject, body: cur.body.trim().replace(/^(Hi|Dear)\b[^\n]*/, (g) => `${g}\n\nI hope your week is going well.`) };
      case "formal": return { subject, body: cur.body.trim().replace(/^Hi\b/, "Dear").replace(/\bThanks\b/g, "Thank you") };
      default: return { subject, body: cur.body.trim().replace(/\bi\b/g, "I").replace(/ {2,}/g, " ").replace(/\borganize/g, "organise") };
    }
  }
  const sign = "Regards,\nAlex";
  switch (o.purpose) {
    case "follow_up": return {
      subject: `Following up: ${role} application`,
      body: `Hi,\n\nI applied for the ${role} role at ${company} last week and wanted to check on the next steps.\n\nI'm still very keen on the role, especially the retrieval work the ad describes.\n\n${sign}`,
    };
    case "thank_you": return {
      subject: `Thank you: ${role} interview`,
      body: `Hi,\n\nThank you for your time today. I enjoyed hearing how the team ships retrieval features.\n\nIt lines up well with the retrieval pipelines I built in my last role. I'd welcome the next step.\n\n${sign}`,
    };
    case "reply": return {
      subject: cur?.subject.trim() || `Re: ${role}`,
      body: `Hi,\n\nThanks for getting in touch. Friday at 10 am works well for me.\n\nIf another time suits better, I'm happy to fit in.\n\n${sign}`,
    };
    case "question": return {
      subject: `Question about the ${role} role`,
      body: `Hi,\n\nI'm interested in the ${role} role at ${company}. Could you tell me whether the role is hybrid, and which days are in the office?\n\n${sign}`,
    };
    case "negotiate": return {
      subject: `Re: ${role} offer`,
      body: `Hi,\n\nThank you for the offer for the ${role} role. I'm keen to join ${company}.\n\nI hold another offer that is higher in total. Is there room to lift the base pay?\n\n${sign}`,
    };
    case "custom": return {
      subject: `${role} at ${company}`,
      body: `Hi,\n\nI wanted to let you know I'm available to start in two weeks.\n\n${sign}`,
    };
    default: return {
      subject: `Application for ${role}`,
      body: `Hi,\n\nI'd like to apply for the ${role} role at ${company}.\n\nI build retrieval pipelines and LLM features in Python, and I've shipped them to production. That matches the core of the ad.\n\nMy resume is attached. I'd be glad to talk about the role.\n\n${sign}`,
    };
  }
}
