import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/dispatch.js";
import { openSample, tmpDir } from "./helpers.js";

// Fictional connections only. Emails are built by concatenation so the privacy scan stays meaningful.
const EMAIL = "sam" + "@" + "example.com";
const CSV = [
  "Notes:",
  "\"Some email addresses may be missing.\"",
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  `Sam,Sample,https://www.linkedin.com/in/sam-sample,${EMAIL},Acme Corp,Engineering Manager,14 Jan 2026`,
  "Jo,Placeholder,,,Example Labs Pty Ltd,Recruiter,02 Feb 2025",
].join("\n");

function put(name: string, text: string): string {
  const p = path.join(tmpDir(), name);
  fs.writeFileSync(p, text);
  return p;
}

describe("network (LinkedIn connections)", () => {
  it("imports Connections.csv into me/network with its own ignore-everything .gitignore, owner-only", async () => {
    const { ctx, root } = openSample();
    expect(await dispatch(ctx, "network.status", [])).toEqual({ count: 0, imported_at: "", file: "" });
    const s = await dispatch(ctx, "network.importLinkedIn", [put("Connections.csv", CSV)]) as { count: number; file: string };
    expect(s).toMatchObject({ count: 2, file: "Connections.csv" });
    const file = path.join(root, "me", "network", "linkedin-connections.json");
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.readFileSync(path.join(root, "me", "network", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(await dispatch(ctx, "network.people", ["Acme Corp"])).toEqual([
      { first: "Sam", last: "Sample", url: "https://www.linkedin.com/in/sam-sample", email: EMAIL, company: "Acme Corp", position: "Engineering Manager" },
    ]);
    expect((await dispatch(ctx, "network.people", ["Example Labs"]) as unknown[]).length).toBe(1);
    expect(await dispatch(ctx, "network.forget", [])).toEqual({ count: 0, imported_at: "", file: "" });
    expect(fs.existsSync(file)).toBe(false);
    expect(await dispatch(ctx, "network.people", ["Acme Corp"])).toEqual([]);
  });

  it("refuses files that aren't a connections CSV, and relative paths", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "network.importLinkedIn", [put("notes.txt", CSV)])).rejects.toThrow(/isn't a CSV/);
    await expect(dispatch(ctx, "network.importLinkedIn", [put("Other.csv", "Date,Amount\n1,2")])).rejects.toThrow(/Connections\.csv/);
    await expect(dispatch(ctx, "network.importLinkedIn", ["Connections.csv"])).rejects.toThrow();
  });
});
