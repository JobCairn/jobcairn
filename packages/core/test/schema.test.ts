import { describe, expect, it } from "vitest";
import { check, defaults } from "../src/schema.js";
import { fieldsFor } from "../src/fields.js";

describe("schema check", () => {
  it("fills defaults for a minimal job without mutating the input", () => {
    const input = { schema: 1, id: "2026-01-15-ai-engineer", company_slug: "acme-corp", title: "AI Engineer" };
    const r = check("job", input);
    expect(r.ok).toBe(true);
    expect(r.value.status).toBe("Found");
    expect(r.value.work_rights.label).toBe("silent");
    expect(r.value.scores.career.match).toBeNull();
    expect(r.value.custom).toEqual({});
    expect(input).not.toHaveProperty("status");
  });
  it("keeps unknown fields", () => {
    const r = check("job", { schema: 1, id: "x", company_slug: "y", title: "T", referee_called: true, salary: { bonus: "10%" } });
    expect(r.ok).toBe(true);
    expect(r.value.referee_called).toBe(true);
    expect(r.value.salary.bonus).toBe("10%");
  });
  it("reports bad enum values with the field path", () => {
    const r = check("job", { schema: 1, id: "x", company_slug: "y", title: "T", status: "Ghosted" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("/status");
  });
  it("rejects unsafe ids", () => {
    expect(check("job", { schema: 1, id: "../x", company_slug: "y", title: "T" }).ok).toBe(false);
  });
  it("builds full defaults from a seed", () => {
    const p = defaults("profile", { contact: { name: "Alex Example" } });
    expect(p.contact.name).toBe("Alex Example");
    expect(p.contact.email).toBe("");
    expect(p.work_rights.status).toBe("unknown");
    expect(p.targets.job_types).toEqual(["full_time"]);
  });
  it("throws on an invalid seed", () => {
    expect(() => defaults("company", { name: "", slug: "acme" })).toThrow(/bad seed/);
  });
});

describe("fieldsFor", () => {
  it("lists labelled profile fields with options", () => {
    const f = fieldsFor("profile");
    const wr = f.find((x) => x.path === "work_rights.status");
    expect(wr?.label).toBe("Work rights");
    expect(wr?.options).toContain("needs_sponsorship");
    expect(f.some((x) => x.path === "contact.name")).toBe(true);
  });
});

describe("3a record kinds", () => {
  it("fills privacy defaults on a workspace record", () => {
    const r = check("workspace", { schema: 1 });
    expect(r.ok).toBe(true);
    expect(r.value.privacy).toEqual({ locked: ["me/identity", "me/employment"], grants: [] });
  });
  it("rejects a lock on a folder that is not lockable", () => {
    expect(check("workspace", { schema: 1, privacy: { locked: ["me/resumes"] } }).ok).toBe(false);
  });
  it("fills approval defaults and rejects unknown actions", () => {
    const ok = check("approval", { schema: 1, id: "20260113t090000-abc123", action: "status_change", title: "Move to Interview" });
    expect(ok.ok).toBe(true);
    expect(ok.value).toMatchObject({ status: "pending", steps: [], payload: {}, created_by: "cli", result_note: "" });
    expect(check("approval", { schema: 1, id: "x", action: "submit_form", title: "T" }).ok).toBe(false);
  });
  it("requires folder and reason on an access request and bounds the minutes", () => {
    const ok = check("access_request", { schema: 1, id: "x", folder: "me/identity", why: "visa expiry" });
    expect(ok.value).toMatchObject({ status: "pending", minutes: 15, who: "claude", field: "" });
    expect(check("access_request", { schema: 1, id: "x", folder: "me/history", why: "w" }).ok).toBe(false);
    expect(check("access_request", { schema: 1, id: "x", folder: "me/identity", why: "w", minutes: 0 }).ok).toBe(false);
    expect(check("access_request", { schema: 1, id: "x", folder: "me/identity", why: "w", minutes: 241 }).ok).toBe(false);
  });
  it("defaults saved job views to an empty list", () => {
    expect(check("search", { schema: 1 }).value.views).toEqual([]);
  });
});
