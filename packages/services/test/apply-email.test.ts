import fs from "node:fs";
import path from "node:path";
import { layout, readRecord, updateRecord } from "@careeros/core";
import { describe, expect, it } from "vitest";
import { applyEmailOf, applyHandlers as A } from "../src/apply.js";
import { approvalHandlers as AP } from "../src/approvals.js";
import { fakeMailHost } from "../src/fakes.js";
import { mailReadHandlers as R } from "../src/mail-read.js";
import { openSample } from "./helpers.js";
import { connectMail, GOOD_PASSWORD, LABS } from "./mail-helpers.js";

const JOBS = "jobs" + "@" + "example.org";

describe("email applications", () => {
  it("offers the apply_via address and moves to confirm after the approved send, without marking applied", async () => {
    const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
    const { ctx, root } = openSample({ mail });
    connectMail(ctx, root);
    updateRecord("job", layout(root).jobFile(...LABS), (j) => { j.apply_via = `mailto:${JOBS}`; });
    const resume = path.join(layout(root).jobDir(...LABS), "application", "resume.md");
    fs.mkdirSync(path.dirname(resume), { recursive: true });
    fs.writeFileSync(resume, "# Alex Example\n");
    const s0 = A["apply.state"](ctx, ...LABS);
    expect(s0).toMatchObject({ apply_email: JOBS, step: "review" });
    const rel = `companies/${LABS[0]}/jobs/${LABS[1]}/application/resume.md`;
    const d = R["mail.drafts.save"](ctx, ...LABS, "", { to: JOBS, cc: "", subject: "Application for Backend Engineer (LLM)", body: "Hi,\n\nMy application is attached.", attach: [rel], in_reply_to: "", references: [], purpose: "apply" });
    const a = R["mail.drafts.propose"](ctx, ...LABS, d.view.draft_id);
    const s1 = A["apply.state"](ctx, ...LABS);
    expect(s1.step).toBe("handoff");
    expect(s1.approval).toMatchObject({ id: a.id, action: "email_send", email: { to: [{ name: "", address: JOBS }] } });
    await AP["approvals.approve"](ctx, a.id, a.digest);
    expect(A["apply.state"](ctx, ...LABS).step).toBe("confirm");
    expect(readRecord("job", layout(root).jobFile(...LABS)).status).not.toBe("Applied");
    expect(mail.fake.sent).toHaveLength(1);
  });
  it("ignores apply_via values that aren't plain addresses", () => {
    const { ctx, root } = openSample();
    for (const v of ["https://jobs.example.com/apply", "mailto:", "not an address"]) {
      updateRecord("job", layout(root).jobFile(...LABS), (j) => { j.apply_via = v; });
      expect(A["apply.state"](ctx, ...LABS).apply_email, v).toBe("");
    }
  });
  it("ignores email sends that aren't applications", () => {
    const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
    const { ctx, root } = openSample({ mail });
    connectMail(ctx, root);
    const d = R["mail.drafts.save"](ctx, ...LABS, "", { to: JOBS, cc: "", subject: "Question", body: "Hi", attach: [], in_reply_to: "", references: [], purpose: "" });
    R["mail.drafts.propose"](ctx, ...LABS, d.view.draft_id);
    expect(A["apply.state"](ctx, ...LABS).approval?.action ?? null).not.toBe("email_send");
  });
  it("reads mailto links with a query", () => {
    expect(applyEmailOf(` mailto:${JOBS}?subject=Hi `)).toBe(JOBS);
    expect(applyEmailOf(JOBS)).toBe(JOBS);
    expect(applyEmailOf("")).toBe("");
  });
});
