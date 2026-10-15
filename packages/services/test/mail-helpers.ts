import { layout, readMeta, refreshIndex, updateRecord } from "@careeros/core";
import { ALEX, parseMessage, storeMessage, type StoreTarget } from "@careeros/mail";
import type { ServiceContext } from "../src/context.js";

export const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
export const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
export const GOOD_PASSWORD = "abcdefghijklmnop";

/** The secret-store key of a workspace's Gmail password ("ws.<workspace_id>.gmail_app_password"). */
export const gmailKey = (root: string): string => `ws.${readMeta(root).workspace_id}.gmail_app_password`;

/** Connects the fictional account directly (the wizard path is tested in mail-account.test.ts). */
export function connectMail(ctx: ServiceContext, root: string): void {
  updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = ALEX; i.mail.display_name = "Alex Example"; i.mail.signature = "Alex Example\nAI Engineer"; });
  ctx.host.secrets.set(gmailKey(root), GOOD_PASSWORD);
}

export async function storeRaw(root: string, target: StoreTarget, raw: Buffer, o: { direction?: "in" | "out"; uid?: number } = {}): Promise<string> {
  const parsed = await parseMessage(raw);
  const s = storeMessage(root, target, {
    raw, parsed, mailbox: "INBOX", direction: o.direction ?? "in", matched_by: target === "triage" ? "none" : "recruiter", tooLarge: false,
    header: { uid: o.uid ?? 1, size: raw.length, internalDate: parsed.date ?? "2026-01-14T09:00:00.000Z", messageId: parsed.message_id, from: [parsed.from], to: parsed.to, cc: parsed.cc, subject: parsed.subject },
  });
  refreshIndex(root, [s.ref]);
  return s.ref;
}
