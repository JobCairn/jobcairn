import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, readAgency, readRecord, validateWorkspace } from "@careeros/core";
import { addr, rawMessage } from "@careeros/mail";
import { webContext } from "../src/claude/context.js";
import { handleMcp } from "../src/claude/mcp/server.js";
import { mcpSession, mcpToolsFor } from "../src/claude/mcp/tools.js";
import { fakeMailHost } from "../src/fakes.js";
import { mailReadHandlers as MR } from "../src/mail-read.js";
import { recruiterAddHandlers as A } from "../src/recruiters-add.js";
import { recruiterHandlers as R } from "../src/recruiters.js";
import { openSample } from "./helpers.js";
import { connectMail, storeRaw } from "./mail-helpers.js";

// Built by concatenation so the privacy scan stays meaningful.
const at = (local: string, domain: string) => local + "@" + domain;
const SITE = "https://sampletalent.example.org";
const NOW = new Date("2026-10-17T00:00:00Z");
type Res = { result?: { content: { text: string }[] } } | null;
const recruiterAdd = (root: string, args: unknown) =>
  JSON.parse((handleMcp(mcpSession(root, mcpToolsFor("check_recruiters")), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recruiter_add", arguments: args } }) as Res)!.result!.content[0]!.text);
const idOf = (ref: string) => path.basename(ref, ".json");

describe("Add recruiter", () => {
  it("saves a website with Added by you, waits for Check recruiters, and Claude's save merges by domain and clears the check", () => {
    const { ctx, root } = openSample();
    const r = A["recruiters.add"](ctx, { text: `${SITE}/contact` });
    expect(r).toEqual({ slug: "sampletalent", name: "Sampletalent", created: true });
    const a = readAgency(root, "sampletalent")!;
    expect(a).toMatchObject({ website: SITE, needs_check: true, sources: [{ name: "Added by you", url: `${SITE}/contact` }] });
    expect(webContext(root, "check_recruiters", { kind: "workspace" }, NOW)).toContain(`Agency: Sampletalent; website ${SITE}; page given ${SITE}/contact`);
    expect(mcpToolsFor("check_recruiters")).toEqual(["recruiter_add", "request_access"]);

    // Claude saves it under its real name: same record (by the site's host), renamed, checked.
    const saved = recruiterAdd(root, { name: "Sample Talent Partners", website: `${SITE}/`, hiring_summary: "Data roles", sources: [{ name: "Agency website", url: SITE }] });
    expect(saved.slug).toBe("sampletalent");
    expect(readAgency(root, "sample-talent-partners")).toBeNull();
    expect(readAgency(root, "sampletalent")).toMatchObject({ name: "Sample Talent Partners", needs_check: false, hiring_summary: "Data roles" });
    expect(webContext(root, "check_recruiters", { kind: "workspace" }, NOW)).not.toContain("Sample Talent");

    // Adding it again by name merges instead of making a second one.
    expect(A["recruiters.add"](ctx, { text: "sampletalent.example.org", name: "Sample Talent" })).toMatchObject({ slug: "sampletalent", created: false });
    expect(validateWorkspace(root).filter((i) => i.file.startsWith("recruiters"))).toEqual([]);
  });

  it("saves a board ad under the board's name and a name with an email as your own contact", () => {
    const { ctx, root } = openSample();
    A["recruiters.add"](ctx, { text: "https://www.seek.com.au/job/123", name: "Example Staffing" });
    expect(readAgency(root, "example-staffing")).toMatchObject({ website: "", sources: [{ name: "SEEK", url: "https://www.seek.com.au/job/123" }] });
    A["recruiters.add"](ctx, { text: `Sample Search\n${at("kim", "samplesearch.example.net")}` });
    expect(readAgency(root, "sample-search")!.contacts).toMatchObject([{ kind: "email", value: at("kim", "samplesearch.example.net"), label: "Added by you", source_url: "" }]);
    expect(() => A["recruiters.add"](ctx, { text: "https://www.seek.com.au/job/9" })).toThrow(/Add the agency's name/);
    expect(validateWorkspace(root).filter((i) => i.file.startsWith("recruiters"))).toEqual([]);
  });

  it("imports a list, merging duplicates by site and listing lines it couldn't use", () => {
    const { ctx, root } = openSample();
    const r = A["recruiters.importList"](ctx, [
      "name,website,email", `Sample Talent,${SITE}`, "Sample Talent Group,https://www.sampletalent.example.org", "https://www.seek.com.au/job/5", `Example Search,,${at("hi", "examplesearch.example.net")}`,
    ].join("\n"));
    expect(r.added.map((x) => x.slug)).toEqual(["sample-talent", "example-search"]);
    expect(r.merged.map((x) => x.slug)).toEqual(["sample-talent"]);
    expect(r.skipped.map((x) => x.line)).toEqual([4]);
    expect(readAgency(root, "sample-talent-group")).toBeNull();
  });
});

describe("recruiter mail", () => {
  it("links a sender to an agency (whole domain only when it isn't free mail), files waiting mail, and the Emails tab shows it", async () => {
    const x = openSample({ mail: fakeMailHost() });
    connectMail(x.ctx, x.root);
    A["recruiters.add"](x.ctx, { text: SITE, name: "Sample Talent" });
    const free = await storeRaw(x.root, "triage", rawMessage({ id: "f1", from: addr("sam.r", "gmail.com"), subject: "Data engineer role", date: "Wed, 14 Oct 2026 09:00:00 +0000" }), { uid: 11 });
    const free2 = await storeRaw(x.root, "triage", rawMessage({ id: "f2", from: addr("sam.r", "gmail.com"), subject: "Re: Data engineer role", date: "Thu, 15 Oct 2026 09:00:00 +0000" }), { uid: 12 });
    const other = await storeRaw(x.root, "triage", rawMessage({ id: "o1", from: addr("lee", "gmail.com"), subject: "Job alert", date: "Thu, 15 Oct 2026 10:00:00 +0000" }), { uid: 13 });
    const items = MR["mail.triage.list"](x.ctx);
    expect(items.find((i) => i.ref === free)?.free_mail).toBe(true);

    expect(() => A["mail.triage.linkAgency"](x.ctx, idOf(free), "sample-talent", "domain")).toThrow(/only this exact address/);
    const left = A["mail.triage.linkAgency"](x.ctx, idOf(free), "sample-talent", "address");
    // Both messages from that address are filed under the agency; the other gmail sender still waits.
    expect(left.map((i) => i.ref)).toEqual([other]);
    expect(fs.existsSync(path.join(x.root, free))).toBe(false);
    expect(fs.existsSync(path.join(x.root, free2))).toBe(false);
    expect(readAgency(x.root, "sample-talent")!.email_match).toEqual([at("sam.r", "gmail.com")]);
    expect(readRecord("company", layout(x.root).companyFile("sample-talent"))).toMatchObject({ type: "recruiter", website: SITE });

    const emails = A["recruiters.emails"](x.ctx, "sample-talent");
    expect(emails.total).toBe(2);
    expect(emails.threads.flatMap((t) => t.messages.map((m) => m.subject))).toEqual(expect.arrayContaining(["Data engineer role", "Re: Data engineer role"]));
    expect(emails.latest_in).toMatch(/^companies\/sample-talent\/emails\//);

    const row = R["recruiters.list"](x.ctx).find((r) => r.slug === "sample-talent")!;
    expect(row.activity.filter((e) => e.event === "Reply received").every((e) => e.tab === "emails")).toBe(true);
    expect(A["recruiters.unlink"](x.ctx, "sample-talent", at("sam.r", "gmail.com")).email_match).toEqual([]);
  });

  it("links a whole work domain", async () => {
    const x = openSample({ mail: fakeMailHost() });
    connectMail(x.ctx, x.root);
    A["recruiters.add"](x.ctx, { text: SITE, name: "Sample Talent" });
    const t = await storeRaw(x.root, "triage", rawMessage({ id: "d1", from: addr("kim", "sampletalent-group.example.net"), subject: "Your application" }), { uid: 21 });
    A["mail.triage.linkAgency"](x.ctx, idOf(t), "sample-talent", "domain");
    expect(readAgency(x.root, "sample-talent")!.email_match).toEqual(["sampletalent-group.example.net"]);
  });
});
