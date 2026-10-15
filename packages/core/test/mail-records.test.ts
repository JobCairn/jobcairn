import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/schema.js";
import { initWorkspace } from "../src/workspace.js";
import { migrate, pendingMigrations } from "../src/migrate.js";
import { LATEST_DATA_VERSION } from "../src/migrations/index.js";
import { layout } from "../src/paths.js";
import { readRecord, updateRecord, writeFileAtomic } from "../src/store.js";
import { newJob } from "../src/jobs.js";
import { FIXED, tmpDir } from "./helpers.js";

const addr = (user: string, domain: string) => user + "@" + domain;
const mid = (s: string) => "<" + s + "@" + "example.org>";

describe("email record", () => {
  it("fills defaults and keeps the core fields", () => {
    const r = check("email", { schema: 1, message_id: mid("a1"), direction: "in", subject: "Interview", date: "2026-01-14T09:00:00.000Z", from: { address: addr("talent", "example.org") } });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      in_reply_to: "", references: [], to: [], cc: [], reply_to: [], uid: null, mailbox: "", matched_by: "none", attachments: [],
      images_allowed: false, remote_images: 0, auth: "none", too_large: false, opened_at: "", thread_key: "",
    });
    expect(r.value.from).toEqual({ name: "", address: addr("talent", "example.org") });
  });
  it("rejects unknown directions and match kinds", () => {
    const base = { schema: 1, message_id: mid("x"), subject: "", date: "", from: { address: "a" } };
    expect(check("email", { ...base, direction: "sideways" }).ok).toBe(false);
    expect(check("email", { ...base, direction: "in", matched_by: "guess" }).ok).toBe(false);
  });
  it("rejects over-long mailbox, attachment part/name and opened_at", () => {
    const base = { schema: 1, message_id: mid("y"), direction: "in" as const, subject: "", date: "", from: { address: "a" } };
    expect(check("email", { ...base, mailbox: "x".repeat(256) }).ok).toBe(false);
    expect(check("email", { ...base, mailbox: "x".repeat(255) }).ok).toBe(true);
    expect(check("email", { ...base, opened_at: "x".repeat(65) }).ok).toBe(false);
    expect(check("email", { ...base, opened_at: "x".repeat(64) }).ok).toBe(true);
    expect(check("email", { ...base, attachments: [{ part: "x".repeat(1025), name: "a.pdf" }] }).ok).toBe(false);
    expect(check("email", { ...base, attachments: [{ part: "x".repeat(1024), name: "a.pdf" }] }).ok).toBe(true);
    expect(check("email", { ...base, attachments: [{ part: "1", name: "x".repeat(1025) }] }).ok).toBe(false);
    expect(check("email", { ...base, attachments: [{ part: "1", name: "x".repeat(1024) }] }).ok).toBe(true);
  });
});

describe("company and settings fields for mail", () => {
  it("adds email_match and recruiter to companies", () => {
    expect(check("company", { schema: 1, name: "Acme Corp", slug: "acme-corp" }).value).toMatchObject({ email_match: [], recruiter: { name: "", email: "" } });
  });
  it("adds the mail block to integrations with safe defaults and bounds", () => {
    expect(check("integrations", { schema: 1 }).value.mail).toEqual({
      provider: "gmail", address: "", display_name: "", signature: "", sync_minutes: 15, first_sync_days: 30,
      background: { on: false, minutes: 60 }, send_limit_per_hour: 10,
    });
    expect(check("integrations", { schema: 1, mail: { sync_minutes: 1 } }).ok).toBe(false);
    expect(check("integrations", { schema: 1, mail: { provider: "outlook" } }).ok).toBe(false);
    expect(check("integrations", { schema: 1, mail: { send_limit_per_hour: 500 } }).ok).toBe(false);
  });
});

describe("migration 2 (mail)", () => {
  it("fills mail defaults on old company and integrations files and backs them up", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const job = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
    const L = layout(root);
    // Rewind to data version 1: no mail fields anywhere.
    const strip = (file: string, keys: string[]) => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const k of keys) delete raw[k];
      writeFileAtomic(file, JSON.stringify(raw, null, 2) + "\n");
    };
    strip(L.companyFile(job.company_slug), ["email_match", "recruiter"]);
    strip(L.integrations, ["mail"]);
    updateRecord("workspace", L.workspaceFile, (w) => { w.data_version = 1; });
    expect(pendingMigrations(root).map((m) => m.id)).toEqual([2, 3, 4]);
    const r = migrate(root, undefined, { now: FIXED });
    expect(r.applied).toEqual([2, 3, 4]);
    expect(JSON.parse(fs.readFileSync(L.companyFile(job.company_slug), "utf8"))).toMatchObject({ email_match: [], recruiter: { name: "", email: "" } });
    expect(JSON.parse(fs.readFileSync(L.integrations, "utf8")).mail.sync_minutes).toBe(15);
    expect(fs.existsSync(path.join(r.backup!, "settings", "integrations.json"))).toBe(true);
    expect(readRecord("workspace", L.workspaceFile).data_version).toBe(LATEST_DATA_VERSION);
  });
  it("skips a broken company file instead of failing the whole migration", () => {
    const root = path.join(tmpDir(), "ws");
    initWorkspace(root, { now: FIXED });
    const job = newJob(root, { company: "Example Labs", title: "Backend Engineer" }, { now: FIXED });
    const L = layout(root);
    fs.writeFileSync(L.companyFile(job.company_slug), "{ broken");
    updateRecord("workspace", L.workspaceFile, (w) => { w.data_version = 1; });
    expect(migrate(root, undefined, { now: FIXED }).applied).toEqual([2, 3, 4]);
  });
  it("knows the mail folders", () => {
    const L = layout("/fictional/ws");
    expect(L.companyEmailsDir("acme-corp")).toBe(path.join("/fictional/ws", "companies", "acme-corp", "emails"));
    expect(L.jobEmailsDir("acme-corp", "j1")).toBe(path.join("/fictional/ws", "companies", "acme-corp", "jobs", "j1", "emails"));
    expect(L.draftsDir("acme-corp", "j1")).toBe(path.join("/fictional/ws", "companies", "acme-corp", "jobs", "j1", "emails", "drafts"));
    expect(L.mailState).toBe(path.join("/fictional/ws", ".careeros", "mail-state.json"));
    expect(L.mailTriage).toBe(path.join("/fictional/ws", ".careeros", "mail-triage"));
  });
});
