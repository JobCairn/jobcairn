import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArgError, type JobDetail, type JobList, type TrashCheck, type TrashItem } from "@careeros/contract";
import { listTrash, moveToTrash, proposeApproval, updateRecord, layout } from "@careeros/core";
import { addr, listTriage, rawMessage } from "@careeros/mail";
import { dispatch } from "../src/dispatch.js";
import { openWorkspace } from "../src/workspace.js";
import { openSample } from "./helpers.js";
import { ACME, storeRaw } from "./mail-helpers.js";

function setup() {
  const s = openSample();
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, call };
}
const JOB = { kind: "job", company_slug: ACME[0], id: ACME[1] } as const;
const jobDir = (root: string) => path.join(root, "companies", ACME[0], "jobs", ACME[1]);
const jobIds = async (call: <T>(m: string, ...a: unknown[]) => Promise<T>) => (await call<JobList>("jobs.list", {})).rows.map((r) => r.id);

describe("Delete a job", () => {
  it("names it, moves it to Recently deleted, drops it from Jobs, and Undo puts it back", async () => {
    const x = setup();
    const chk = await x.call<TrashCheck>("trash.check", JOB);
    expect(chk).toEqual({ title: "AI Engineer at Acme Corp", also: "", note: "", blocked: null });
    const [entry] = await x.call<TrashItem[]>("trash.move", [JOB]);
    expect(entry).toMatchObject({ kind: "job", title: "AI Engineer at Acme Corp" });
    expect(Date.parse(entry!.purge_at) - Date.parse(entry!.deleted_at)).toBe(30 * 86_400_000);
    expect(fs.existsSync(jobDir(x.root))).toBe(false);
    expect(await jobIds(x.call)).not.toContain(ACME[1]);
    await expect(x.call("jobs.get", ...JOB_ARGS)).rejects.toThrow();
    expect((await x.call<TrashItem[]>("trash.list")).map((e) => e.id)).toEqual([entry!.id]);

    await x.call("trash.restore", entry!.id);
    expect(await jobIds(x.call)).toContain(ACME[1]);
    expect(await x.call<TrashItem[]>("trash.list")).toEqual([]);
  });

  it("keeps the job's emails in Mail under its company, and moves them back on Undo", async () => {
    const x = setup();
    const ref = await storeRaw(x.root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({ id: "m1", from: addr("talent", "acme.example.com"), subject: "Interview times" }));
    expect((await x.call<TrashCheck>("trash.check", JOB)).note).toBe("Its 1 email stay in Mail, under Acme Corp.");
    const [entry] = await x.call<TrashItem[]>("trash.move", [JOB]);
    const mail = await x.call<{ rows: { ref: string; job_id: string }[] }>("mail.list", { company_slug: ACME[0], includeCompany: true });
    expect(mail.rows.map((r) => [r.ref.startsWith(`companies/${ACME[0]}/emails/`), r.job_id])).toEqual([[true, ""]]);
    await x.call("trash.restore", entry!.id);
    const back = await x.call<{ rows: { ref: string; job_id: string }[] }>("mail.list", { company_slug: ACME[0], id: ACME[1] });
    expect(back.rows.map((r) => r.ref)).toEqual([ref]);
  });

  it("refuses while something waits for approval on the job, and says why", async () => {
    const x = setup();
    proposeApproval(x.root, { action: "apply_handoff", title: "Apply", payload: { company_slug: ACME[0], id: ACME[1], url: "https://jobs.example.com/1", files: [] }, created_by: "app" });
    expect((await x.call<TrashCheck>("trash.check", JOB)).blocked).toMatch(/waiting for your approval/);
    await expect(x.call("trash.move", [JOB])).rejects.toThrow(/waiting for your approval/);
    expect(fs.existsSync(jobDir(x.root))).toBe(true);
  });

  it("deletes several jobs at once, and one that can't go stops all of them", async () => {
    const x = setup();
    const other = { kind: "job", company_slug: "acme-recruiting", id: "2026-01-12-ai-developer" };
    await expect(x.call("trash.move", [JOB, { kind: "job", company_slug: "acme-corp", id: "gone" }])).rejects.toThrow(/isn't there any more/);
    expect(fs.existsSync(jobDir(x.root))).toBe(true);
    const done = await x.call<TrashItem[]>("trash.move", [JOB, other]);
    expect(done.map((d) => d.kind)).toEqual(["job", "job"]);
    expect(await jobIds(x.call)).toEqual(["2026-01-12-backend-engineer-llm"]);
    // The example's Example Labs job has an approval waiting: in a list, it stops the whole delete.
    await expect(x.call("trash.move", [{ kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }])).rejects.toThrow(/waiting for your approval/);
  });
});

const JOB_ARGS = [ACME[0], ACME[1]] as const;

describe("Delete a company", () => {
  it("takes its jobs, moves its emails to To sort, and Undo brings it all back", async () => {
    const x = setup();
    await storeRaw(x.root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({ id: "m2", from: addr("talent", "acme.example.com"), subject: "Thanks for applying" }));
    const t = { kind: "company", company_slug: ACME[0] };
    expect(await x.call<TrashCheck>("trash.check", t)).toEqual({ title: "Acme Corp", also: "its 1 job", note: "Its 1 email stay in Mail, under To sort.", blocked: null });
    const [entry] = await x.call<TrashItem[]>("trash.move", [t]);
    expect(entry).toMatchObject({ title: "Acme Corp", also: "its 1 job" });
    expect(fs.existsSync(path.join(x.root, "companies", ACME[0]))).toBe(false);
    expect(listTriage(x.root)).toHaveLength(1);
    expect((await x.call<{ slug: string }[]>("companies.list")).map((c) => c.slug)).not.toContain(ACME[0]);

    await x.call("trash.restore", entry!.id);
    expect(listTriage(x.root)).toHaveLength(0);
    expect(await jobIds(x.call)).toContain(ACME[1]);
    expect((await x.call<{ rows: unknown[] }>("mail.list", { company_slug: ACME[0], id: ACME[1] })).rows).toHaveLength(1);
  });

  it("a company and its own job in one request: the company takes the job", async () => {
    const x = setup();
    const done = await x.call<TrashItem[]>("trash.move", [JOB, { kind: "company", company_slug: ACME[0] }]);
    expect(done.map((d) => d.kind)).toEqual(["company"]);
  });
});

describe("Delete a job file, a topic, a resume", () => {
  it("takes a cover letter out of the job's files and puts it back on Undo", async () => {
    const x = setup();
    fs.mkdirSync(path.join(jobDir(x.root), "application"), { recursive: true });
    fs.writeFileSync(path.join(jobDir(x.root), "application", "cover-letter.md"), "Dear Acme Corp,\n");
    updateRecord("job", layout(x.root).jobFile(...JOB_ARGS), (j) => { j.files.push({ path: "application/cover-letter.md", label: "Cover letter", added_at: "2026-01-15T09:00:00.000Z" } as never); });
    const t = { kind: "job_file", company_slug: ACME[0], id: ACME[1], path: "application/cover-letter.md" };
    const [entry] = await x.call<TrashItem[]>("trash.move", [t]);
    expect(entry!.title).toBe("Cover letter");
    let d = await x.call<JobDetail>("jobs.get", ...JOB_ARGS);
    expect(d.files.map((f) => f.path)).not.toContain("application/cover-letter.md");
    await x.call("trash.restore", entry!.id);
    d = await x.call<JobDetail>("jobs.get", ...JOB_ARGS);
    expect(d.files.find((f) => f.path === "application/cover-letter.md")).toMatchObject({ exists: true, label: "Cover letter" });
  });

  it("never deletes the job's own record or ad as a file", async () => {
    const x = setup();
    for (const p of ["job.json", "jd.md"]) {
      await expect(x.call("trash.move", [{ kind: "job_file", company_slug: ACME[0], id: ACME[1], path: p }])).rejects.toThrow(/belongs to the job itself/);
    }
  });

  it("deletes a Learn topic", async () => {
    const x = setup();
    const [entry] = await x.call<TrashItem[]>("trash.move", [{ kind: "topic", topic: "rag-pipelines" }]);
    expect(entry!.kind).toBe("topic");
    expect(fs.existsSync(path.join(x.root, "learning", "rag-pipelines"))).toBe(false);
    await expect(x.call("trash.check", { kind: "topic", topic: "rag-pipelines" })).rejects.toThrow(/isn't in Learn any more/);
  });
});

describe("Bridge checks", () => {
  it("refuses paths, path tricks and unknown kinds before anything is read", async () => {
    const x = setup();
    const bad: unknown[] = [
      { kind: "job", company_slug: "../acme-corp", id: ACME[1] },
      { kind: "company", company_slug: ".." },
      { kind: "topic", topic: "../companies" },
      { kind: "topic", topic: ".." },
      { kind: "video", folder: "../../etc" },
      { kind: "job_file", company_slug: ACME[0], id: ACME[1], path: "../../../settings/profile.json" },
      { kind: "resume", ref: { kind: "base", rel: "me/identity/passport.pdf" } },
      { kind: "folder", path: "companies" },
      { kind: "job", company_slug: ACME[0], id: ACME[1], path: "/etc" },
    ];
    for (const t of bad) await expect(x.call("trash.move", [t]), JSON.stringify(t)).rejects.toBeInstanceOf(ArgError);
    await expect(x.call("trash.restore", "../../companies")).rejects.toBeInstanceOf(ArgError);
    await expect(x.call("trash.forget", "../..", true)).rejects.toBeInstanceOf(ArgError);
    expect(fs.existsSync(path.join(x.root, "companies", ACME[0]))).toBe(true);
  });

  it("deletes forever only when confirmed", async () => {
    const x = setup();
    const [entry] = await x.call<TrashItem[]>("trash.move", [JOB]);
    await expect(x.call("trash.forget", entry!.id, false)).rejects.toThrow(/Confirm first/);
    await x.call("trash.forget", entry!.id, true);
    expect(await x.call<TrashItem[]>("trash.list")).toEqual([]);
    await expect(x.call("trash.restore", entry!.id)).rejects.toThrow(/isn't in Recently deleted/);
  });

  it("says when its old place is taken", async () => {
    const x = setup();
    const [entry] = await x.call<TrashItem[]>("trash.move", [JOB]);
    fs.mkdirSync(jobDir(x.root));
    await expect(x.call("trash.restore", entry!.id)).rejects.toThrow(/Something new is at its old place/);
  });
});

describe("Opening a workspace", () => {
  it("removes entries deleted more than 30 days ago", () => {
    const x = setup();
    moveToTrash(x.root, { kind: "job", title: "Old", rels: [`companies/${ACME[0]}/jobs/${ACME[1]}`] }, { now: new Date("2025-11-01T00:00:00Z") });
    moveToTrash(x.root, { kind: "topic", title: "Recent", rels: ["learning/rag-pipelines"] }, { now: new Date("2026-01-10T00:00:00Z") });
    openWorkspace(x.ctx, x.root);
    expect(listTrash(x.root).map((e) => e.title)).toEqual(["Recent"]);
  });
});
